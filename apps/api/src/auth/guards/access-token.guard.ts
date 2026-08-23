import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthRepository } from '../auth.repository';
import { AuthService } from '../auth.service';
import { TokenService, type AccessTokenClaims } from '../token.service';
import { JwtExpiredError } from '../jwt';
import { TokenExpiredError, TokenInvalidError } from '../auth.errors';

export const IS_PUBLIC = 'isPublic';

/** Marks a route as reachable without authentication. Everything else is denied by default. */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC, true);

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    sessionId: string;
    deviceId?: string;
    kycLevel: string;
  };
}

/**
 * Verifies the access token on every request (deny-by-default — rule 2).
 *
 * Beyond signature and expiry it re-checks, on every request:
 *  - the session still exists and is not revoked (logout and family revocation take
 *    effect immediately, not when the 10-minute token happens to expire), and
 *  - the account is still usable (a suspension applies now, not at next login).
 *
 * That is two database reads per request. They are cheap, indexed, and the alternative —
 * trusting the token alone — means a revoked session keeps working for up to 10 minutes.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly repository: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new TokenInvalidError('Authentication required');

    let claims: AccessTokenClaims;
    try {
      claims = this.tokens.verifyAccessToken(header.slice('Bearer '.length));
    } catch (error) {
      // Expiry is distinguished so the client knows to refresh rather than re-authenticate.
      if (error instanceof JwtExpiredError) throw new TokenExpiredError();
      throw new TokenInvalidError();
    }

    const session = await this.repository.findSession(claims.sid);
    if (!session || session.revokedAt !== null) throw new TokenInvalidError('Session ended');

    const user = await this.repository.findUserById(claims.sub);
    if (!user) throw new TokenInvalidError();
    AuthService.assertUsable(user);

    request.auth = {
      userId: user.id,
      sessionId: claims.sid,
      ...(claims.did ? { deviceId: claims.did } : {}),
      kycLevel: user.kycLevel,
    };
    return true;
  }
}
