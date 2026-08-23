import { createSign, generateKeyPairSync } from 'node:crypto';
import type Redis from 'ioredis';
import { RequestSigningService } from './request-signing.service';

function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const spkiBase64 = publicKey.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s/g, '');
  return { privateKey, spkiBase64 };
}

function sign(privateKey: string, payload: string): string {
  const signer = createSign('SHA256');
  signer.update(payload);
  signer.end();
  return signer.sign(privateKey).toString('base64');
}

/** Redis that accepts each nonce once — the real NX semantics. */
function nonceStore(): Redis {
  const seen = new Set<string>();
  return {
    set: (key: string) => Promise.resolve(seen.has(key) ? null : (seen.add(key), 'OK')),
  } as unknown as Redis;
}

describe('RequestSigningService (ADR-013)', () => {
  const device = makeDevice();

  function partsFor(overrides: Partial<Parameters<RequestSigningService['verify']>[0]> = {}) {
    const base = {
      method: 'POST',
      path: '/api/v1/wallet/debit',
      body: JSON.stringify({ amount: 500 }),
      timestamp: String(Date.now()),
      nonce: `nonce-${Math.random()}`,
    };
    const merged = { ...base, ...overrides };
    return {
      ...merged,
      signature: overrides.signature ?? sign(device.privateKey, RequestSigningService.canonicalPayload(merged)),
      devicePublicKey: overrides.devicePublicKey ?? device.spkiBase64,
    };
  }

  it('accepts a correctly signed request', async () => {
    const service = new RequestSigningService(nonceStore());
    await expect(service.verify(partsFor())).resolves.toEqual({ ok: true });
  });

  it('rejects a tampered body — the signature covers the body hash', async () => {
    const service = new RequestSigningService(nonceStore());
    const parts = partsFor();
    const tampered = { ...parts, body: JSON.stringify({ amount: 500_000 }) };
    await expect(service.verify(tampered)).resolves.toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered path — a signature cannot be moved to another endpoint', async () => {
    const service = new RequestSigningService(nonceStore());
    const parts = partsFor();
    await expect(service.verify({ ...parts, path: '/api/v1/wallet/withdraw' })).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a replayed nonce', async () => {
    const service = new RequestSigningService(nonceStore());
    const parts = partsFor();
    await expect(service.verify(parts)).resolves.toEqual({ ok: true });
    // Byte-identical replay of a valid request must not succeed twice.
    await expect(service.verify(parts)).resolves.toEqual({ ok: false, reason: 'replayed_nonce' });
  });

  it('rejects a stale timestamp beyond the skew window', async () => {
    const service = new RequestSigningService(nonceStore());
    const old = String(Date.now() - (RequestSigningService.maxSkewSeconds + 30) * 1000);
    await expect(service.verify(partsFor({ timestamp: old }))).resolves.toEqual({
      ok: false,
      reason: 'clock_skew',
    });
  });

  it('rejects a signature from a different device key', async () => {
    const service = new RequestSigningService(nonceStore());
    const other = makeDevice();
    const parts = partsFor();
    const forged = { ...parts, signature: sign(other.privateKey, RequestSigningService.canonicalPayload(parts)) };
    await expect(service.verify(forged)).resolves.toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('FAILS CLOSED when the nonce store is unavailable', async () => {
    // Unlike rate limiting, replay protection guards money: an unenforceable guard must
    // block rather than wave the request through.
    const deadRedis = { set: () => Promise.reject(new Error('down')) } as unknown as Redis;
    const service = new RequestSigningService(deadRedis);
    await expect(service.verify(partsFor())).resolves.toEqual({
      ok: false,
      reason: 'nonce_store_unavailable',
    });
  });

  it('rejects a malformed key or signature without throwing', async () => {
    const service = new RequestSigningService(nonceStore());
    await expect(service.verify(partsFor({ devicePublicKey: 'not-a-key' }))).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    await expect(service.verify(partsFor({ signature: 'not-a-signature' }))).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
