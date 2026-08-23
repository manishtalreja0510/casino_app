import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signJwt, verifyJwt, type JwtClaims } from './jwt';

export interface AccessTokenClaims extends JwtClaims {
  /** User id. */
  sub: string;
  /** Session id — lets a single session be revoked without touching the user's others. */
  sid: string;
  /** Device id, when the session is device-bound. */
  did?: string;
  /** KYC level, so authorisation checks need no extra query (OQ-03: everyone is L0 today). */
  lvl: string;
}

/**
 * Access and refresh tokens (ADR-013).
 *
 * Access: ES256 JWT, 10-minute TTL, minimal claims — **no email, no name**: a JWT is
 * readable by anyone holding it, so it carries identifiers rather than personal data
 * (rule 15).
 *
 * Refresh: an opaque 256-bit random string. Not a JWT, because it must be revocable and
 * single-use, which means the server has to look it up anyway. Only its SHA-256 is
 * stored, so a database leak does not yield usable tokens.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  static readonly accessTokenTtlSeconds = 10 * 60;
  static readonly refreshTokenTtlDays = 30;

  private static readonly issuer = 'casino-app';
  private static readonly audience = 'casino-app-client';

  constructor(private readonly config: ConfigService) {}

  issueAccessToken(claims: Omit<AccessTokenClaims, 'iat' | 'exp'>): string {
    return signJwt(claims, this.privateKeyPem(), {
      keyId: this.keyId(),
      expiresInSeconds: TokenService.accessTokenTtlSeconds,
      issuer: TokenService.issuer,
      audience: TokenService.audience,
    });
  }

  /** Throws {@link JwtExpiredError} on expiry so callers can distinguish it from invalidity. */
  verifyAccessToken(token: string): AccessTokenClaims {
    return verifyJwt(token, this.publicKeyPem(), {
      issuer: TokenService.issuer,
      audience: TokenService.audience,
    }) as AccessTokenClaims;
  }

  /** A fresh opaque refresh token plus the hash to store. The token is returned once. */
  createRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: TokenService.hashRefreshToken(token) };
  }

  static hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static refreshExpiry(from: Date = new Date()): Date {
    return new Date(from.getTime() + TokenService.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  }

  private keyId(): string {
    return this.config.get<string>('JWT_KEY_ID') ?? 'dev-1';
  }

  private privateKeyPem(): string {
    // Newlines survive .env round-tripping as literal \n; restore them for the PEM parser.
    return this.config.getOrThrow<string>('JWT_PRIVATE_KEY').replace(/\\n/g, '\n');
  }

  private publicKeyPem(): string {
    return this.config.getOrThrow<string>('JWT_PUBLIC_KEY').replace(/\\n/g, '\n');
  }
}
