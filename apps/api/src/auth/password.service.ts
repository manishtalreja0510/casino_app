import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing (Argon2id).
 *
 * Library defaults are used deliberately (19 MiB, t=2, p=1 — the OWASP-recommended
 * baseline); parameters are encoded in the hash string, so raising cost later re-hashes
 * on next login rather than invalidating every credential.
 */
@Injectable()
export class PasswordService {
  /** Argon2id hash of a plaintext password. The plaintext is never stored or logged. */
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext);
  }

  async verify(passwordHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(passwordHash, plaintext);
    } catch {
      // A malformed stored hash must fail closed, not throw into the request pipeline.
      return false;
    }
  }

  /**
   * Burns roughly the same time as a real verification.
   *
   * Called when the email does not exist so that login latency does not disclose whether
   * an account is registered — otherwise the endpoint becomes an account-enumeration
   * oracle (`docs/04-security/authentication-security.md`).
   *
   * The decoy hash is generated once at first use with the same parameters as a real
   * credential, so the work performed genuinely matches. It is derived from random bytes
   * and is not a credential for anything.
   */
  async dummyVerify(): Promise<void> {
    this.decoyHash ??= hash(randomBytes(32).toString('hex'));
    await verify(await this.decoyHash, 'not-the-password');
  }

  private decoyHash?: Promise<string>;
}
