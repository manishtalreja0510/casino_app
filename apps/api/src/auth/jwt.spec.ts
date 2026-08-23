import { createHmac, generateKeyPairSync } from 'node:crypto';
import { JwtError, JwtExpiredError, signJwt, verifyJwt } from './jwt';

const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const options = { issuer: 'casino-app', audience: 'casino-app-client' };
const signOptions = { ...options, expiresInSeconds: 600, keyId: 'test-1' };

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('ES256 JWT', () => {
  it('round-trips claims', () => {
    const token = signJwt({ sub: 'user-1', sid: 'session-1', lvl: 'L0' }, privateKey, signOptions);
    const claims = verifyJwt(token, publicKey, options);
    expect(claims.sub).toBe('user-1');
    expect(claims.sid).toBe('session-1');
    expect(claims.exp).toEqual(expect.any(Number));
  });

  it('carries the key id so keys can be rotated', () => {
    const token = signJwt({ sub: 'user-1' }, privateKey, signOptions);
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header.kid).toBe('test-1');
    expect(header.alg).toBe('ES256');
  });

  it('rejects a token signed by a different key', () => {
    const other = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const forged = signJwt({ sub: 'attacker' }, other.privateKey, signOptions);
    expect(() => verifyJwt(forged, publicKey, options)).toThrow(JwtError);
  });

  it('rejects a tampered payload', () => {
    const token = signJwt({ sub: 'user-1', lvl: 'L0' }, privateKey, signOptions);
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${base64url({ sub: 'user-1', lvl: 'L2', iss: 'casino-app', aud: 'casino-app-client', exp: 9_999_999_999 })}.${signature}`;
    expect(() => verifyJwt(tampered, publicKey, options)).toThrow(/invalid signature/);
  });

  it('REJECTS the alg:none forgery', () => {
    // The classic JWT attack: strip the signature and claim no algorithm was used.
    const forged = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: 'attacker', iss: 'casino-app', aud: 'casino-app-client', exp: 9_999_999_999 })}.`;
    expect(() => verifyJwt(forged, publicKey, options)).toThrow(/unsupported algorithm/);
  });

  it('REJECTS an HMAC-signed token even if it verifies against the public key as a secret', () => {
    // Algorithm confusion: sign with HS256 using the public key as the shared secret.
    const header = base64url({ alg: 'HS256', typ: 'JWT' });
    const payload = base64url({ sub: 'attacker', iss: 'casino-app', aud: 'casino-app-client', exp: 9_999_999_999 });
    const mac = createHmac('sha256', publicKey).update(`${header}.${payload}`).digest('base64url');
    expect(() => verifyJwt(`${header}.${payload}.${mac}`, publicKey, options)).toThrow(
      /unsupported algorithm/,
    );
  });

  it('rejects an expired token distinctly, so the client knows to refresh', () => {
    const token = signJwt({ sub: 'user-1' }, privateKey, { ...signOptions, expiresInSeconds: -120 });
    expect(() => verifyJwt(token, publicKey, options)).toThrow(JwtExpiredError);
  });

  it('rejects a token minted for another issuer or audience', () => {
    const wrongIssuer = signJwt({ sub: 'user-1' }, privateKey, { ...signOptions, issuer: 'someone-else' });
    expect(() => verifyJwt(wrongIssuer, publicKey, options)).toThrow(/issuer/);

    const wrongAudience = signJwt({ sub: 'user-1' }, privateKey, { ...signOptions, audience: 'another-client' });
    expect(() => verifyJwt(wrongAudience, publicKey, options)).toThrow(/audience/);
  });

  it('rejects malformed tokens without throwing something unexpected', () => {
    for (const malformed of ['', 'a.b', 'a.b.c.d', 'not-a-token']) {
      expect(() => verifyJwt(malformed, publicKey, options)).toThrow(Error);
    }
  });
});
