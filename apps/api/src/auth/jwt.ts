import { createPrivateKey, createPublicKey, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

/**
 * Minimal ES256 (ECDSA P-256 + SHA-256) JWT signer/verifier over `node:crypto`.
 *
 * Written here rather than taken from a library because `jose` v6 is ESM-only, which a
 * CommonJS Nest build cannot require — the same trap that `uuid` v14 set in P1. JWS
 * signatures for ES256 are the raw r‖s pair, which Node produces directly with
 * `dsaEncoding: 'ieee-p1363'`; no DER conversion is needed.
 *
 * Security properties this implementation is responsible for:
 *  - **The algorithm is fixed at ES256.** The `alg` header is checked against it and
 *    nothing else is accepted — `none`, HMAC algorithms, and any other value are rejected
 *    outright. Trusting the token's own `alg` header is the classic JWT forgery.
 *  - Expiry (`exp`), not-before (`nbf`), issuer and audience are all verified.
 *  - Signature comparison is done by the crypto primitive; the header/claim comparisons
 *    that could leak by timing use `timingSafeEqual`.
 */

export class JwtError extends Error {}
export class JwtExpiredError extends JwtError {
  constructor() {
    super('token expired');
  }
}

export interface JwtClaims {
  [claim: string]: unknown;
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
}

const ALG = 'ES256';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export function signJwt(
  claims: JwtClaims,
  privateKeyPem: string,
  options: { keyId?: string; expiresInSeconds: number; issuer: string; audience: string },
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: ALG, typ: 'JWT', ...(options.keyId ? { kid: options.keyId } : {}) };
  const payload: JwtClaims = {
    ...claims,
    iss: options.issuer,
    aud: options.audience,
    iat: now,
    exp: now + options.expiresInSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: toPrivateKey(privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

export function verifyJwt(
  token: string,
  publicKeyPem: string,
  options: { issuer: string; audience: string; clockToleranceSeconds?: number },
): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeSegment(headerSegment) as { alg?: unknown; typ?: unknown };
  // Algorithm is dictated by us, never by the token.
  if (typeof header.alg !== 'string' || !constantTimeEquals(header.alg, ALG)) {
    throw new JwtError('unsupported algorithm');
  }

  const signatureValid = verify(
    'sha256',
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    { key: toPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureSegment, 'base64url'),
  );
  if (!signatureValid) throw new JwtError('invalid signature');

  const claims = decodeSegment(payloadSegment) as JwtClaims;
  const tolerance = options.clockToleranceSeconds ?? 5;
  const now = Math.floor(Date.now() / 1000);

  if (typeof claims.exp !== 'number' || claims.exp + tolerance < now) throw new JwtExpiredError();
  if (typeof claims.nbf === 'number' && claims.nbf - tolerance > now) throw new JwtError('token not yet valid');
  if (claims.iss !== options.issuer) throw new JwtError('unexpected issuer');
  if (claims.aud !== options.audience) throw new JwtError('unexpected audience');

  return claims;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const privateKeyCache = new Map<string, KeyObject>();
const publicKeyCache = new Map<string, KeyObject>();

function toPrivateKey(pem: string): KeyObject {
  let key = privateKeyCache.get(pem);
  if (!key) {
    key = createPrivateKey(pem);
    privateKeyCache.set(pem, key);
  }
  return key;
}

function toPublicKey(pem: string): KeyObject {
  let key = publicKeyCache.get(pem);
  if (!key) {
    key = createPublicKey(pem);
    publicKeyCache.set(pem, key);
  }
  return key;
}
