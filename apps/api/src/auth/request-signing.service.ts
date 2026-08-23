import { createHash, createVerify } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../platform/redis/redis.module';

export interface SignedRequestParts {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  nonce: string;
  signature: string;
  /** SPKI public key (base64) of the registered device. */
  devicePublicKey: string;
}

export type SignatureFailure =
  | 'clock_skew'
  | 'replayed_nonce'
  | 'bad_signature'
  | 'nonce_store_unavailable';

/**
 * Verifies detached signatures on financial-class requests (ADR-013).
 *
 * Signed payload: `method|path|sha256(body)|timestamp|nonce`, signed by the device's
 * Android Keystore-backed P-256 key. What this defends: a stolen access token replayed
 * from another device, and tampering with a request in flight. What it does NOT defend:
 * a fully compromised device — nothing client-side can (rule 1).
 */
@Injectable()
export class RequestSigningService {
  private readonly logger = new Logger(RequestSigningService.name);

  /** Requests outside this window are rejected; also bounds how long a nonce must be kept. */
  static readonly maxSkewSeconds = 120;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  static canonicalPayload(parts: Omit<SignedRequestParts, 'signature' | 'devicePublicKey'>): string {
    const bodyHash = createHash('sha256').update(parts.body ?? '').digest('hex');
    return [parts.method.toUpperCase(), parts.path, bodyHash, parts.timestamp, parts.nonce].join('|');
  }

  async verify(parts: SignedRequestParts): Promise<{ ok: true } | { ok: false; reason: SignatureFailure }> {
    const skew = Math.abs(Date.now() - Number(parts.timestamp)) / 1000;
    if (!Number.isFinite(skew) || skew > RequestSigningService.maxSkewSeconds) {
      return { ok: false, reason: 'clock_skew' };
    }

    if (!this.verifySignature(parts)) {
      return { ok: false, reason: 'bad_signature' };
    }

    // Signature checked first, nonce second: an attacker should not be able to burn
    // nonces (or fill the cache) with unsigned requests.
    return this.claimNonce(parts.nonce);
  }

  private verifySignature(parts: SignedRequestParts): boolean {
    try {
      const payload = RequestSigningService.canonicalPayload(parts);
      const verifier = createVerify('SHA256');
      verifier.update(payload);
      verifier.end();
      const key = `-----BEGIN PUBLIC KEY-----\n${parts.devicePublicKey}\n-----END PUBLIC KEY-----\n`;
      return verifier.verify(key, Buffer.from(parts.signature, 'base64'));
    } catch {
      // Malformed key or signature is a failed verification, never an exception upward.
      return false;
    }
  }

  /**
   * Claims a nonce for the skew window.
   *
   * **Fails closed.** If Redis is unavailable the request is refused: unlike rate
   * limiting, replay protection guards money, and an unenforceable guard must block
   * rather than wave traffic through (rules 1, 6).
   */
  private async claimNonce(nonce: string): Promise<{ ok: true } | { ok: false; reason: SignatureFailure }> {
    try {
      const stored = await this.redis.set(
        `sig:nonce:${nonce}`,
        '1',
        'EX',
        RequestSigningService.maxSkewSeconds * 2,
        'NX',
      );
      return stored === 'OK' ? { ok: true } : { ok: false, reason: 'replayed_nonce' };
    } catch (error) {
      this.logger.error(
        `nonce store unavailable (${error instanceof Error ? error.message : 'unknown'}); refusing signed request`,
      );
      return { ok: false, reason: 'nonce_store_unavailable' };
    }
  }
}
