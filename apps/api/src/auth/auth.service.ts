import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { withTransaction } from '../platform/database/transaction';
import { AuditService } from '../platform/audit/audit.service';
import { uuidv7 } from '../platform/ids/uuid-v7';
import { AuthRepository, type AccountStatus, type SessionRow, type UserRow } from './auth.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import {
  AccountUnavailableError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  RefreshReuseDetectedError,
  TokenInvalidError,
} from './auth.errors';

export interface RequestContext {
  ip: string | null;
  country: string | null;
  userAgent: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface AuthResult extends AuthTokens {
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  kycLevel: string;
}

/** What a listener is told when a session begins. Opaque identifiers only (rule 15). */
export interface SessionStarted {
  userId: string;
  sessionId: string;
  deviceId?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async register(
    input: { email: string; password: string; displayName: string },
    context: RequestContext,
  ): Promise<AuthResult> {
    const email = AuthService.normaliseEmail(input.email);

    // Checked before the transaction for a clean error, and enforced by a unique index
    // regardless — two simultaneous registrations must not both succeed.
    if (await this.repository.emailExists(email)) {
      throw new EmailAlreadyRegisteredError();
    }

    const passwordHash = await this.passwords.hash(input.password);

    try {
      return await withTransaction(this.pool, async (client) => {
        const user = await this.repository.createUser(client, {
          email,
          displayName: input.displayName.trim(),
          passwordHash,
          country: context.country,
        });
        const session = await this.startSession(client, user, null, context, 'register');
        return { ...session, user: AuthService.toPublicUser(user) };
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('users_email_uq')) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }

  async login(
    input: { email: string; password: string; deviceId?: string | null },
    context: RequestContext,
  ): Promise<AuthResult> {
    const email = AuthService.normaliseEmail(input.email);
    const found = await this.repository.findUserByEmail(email);

    if (!found) {
      // Burn comparable time so response latency does not disclose account existence.
      await this.passwords.dummyVerify();
      throw new InvalidCredentialsError();
    }

    const passwordOk = await this.passwords.verify(found.passwordHash, input.password);
    if (!passwordOk) {
      await this.audit.append({
        actorType: 'user',
        actorId: found.id,
        action: 'auth.login_failed',
        subjectRef: found.id,
        payload: { reason: 'bad_password' },
      });
      throw new InvalidCredentialsError();
    }

    AuthService.assertUsable(found);

    return withTransaction(this.pool, async (client) => {
      const session = await this.startSession(client, found, input.deviceId ?? null, context, 'login');
      return { ...session, user: AuthService.toPublicUser(found) };
    });
  }

  /**
   * Rotates a refresh token.
   *
   * The security-critical branch is reuse: presenting an already-used token means two
   * parties hold the chain, so the whole family — and its sessions — are revoked and the
   * event is audited (ADR-013).
   *
   * **Why this is two transactions.** The reuse response cannot happen inside the
   * transaction that detects it: throwing rolls that transaction back, which would undo
   * the revocation and leave the stolen chain alive. Nor can a second transaction be
   * opened while the first still holds `FOR UPDATE` on the token row — they would
   * deadlock. So the first transaction classifies and commits, releasing its lock, and
   * the revocation runs in its own transaction afterwards.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const tokenHash = TokenService.hashRefreshToken(refreshToken);

    const outcome = await withTransaction(this.pool, async (client) => {
      const existing = await this.repository.findRefreshTokenForUpdate(client, tokenHash);
      if (!existing) return { kind: 'invalid' as const };

      if (existing.usedAt !== null) {
        // Classify only — the revocation happens after this transaction commits.
        return {
          kind: 'reuse' as const,
          familyId: existing.familyId,
          userId: existing.userId,
          sessionId: existing.sessionId,
        };
      }

      if (existing.revokedAt !== null || existing.expiresAt.getTime() <= Date.now()) {
        return { kind: 'invalid' as const };
      }

      const session = await this.repository.findSession(existing.sessionId);
      if (!session || session.revokedAt !== null) return { kind: 'invalid' as const };

      const user = await this.repository.findUserById(existing.userId);
      if (!user) return { kind: 'invalid' as const };
      // Status is re-checked on rotation: a suspension must end the session's ability to
      // renew itself, not merely block new logins.
      AuthService.assertUsable(user);

      const next = this.tokens.createRefreshToken();
      const nextId = await this.repository.insertRefreshToken(client, {
        familyId: existing.familyId,
        sessionId: existing.sessionId,
        userId: existing.userId,
        tokenHash: next.hash,
        expiresAt: TokenService.refreshExpiry(),
      });
      await this.repository.markRefreshUsed(client, existing.id, nextId);
      // Keeps the session list's "last seen" meaningful for a player reviewing devices.
      await client.query('UPDATE auth.sessions SET last_seen_at = now() WHERE id = $1', [
        existing.sessionId,
      ]);

      const accessToken = this.tokens.issueAccessToken({
        sub: user.id,
        sid: existing.sessionId,
        ...(session.deviceId ? { did: session.deviceId } : {}),
        lvl: user.kycLevel,
      });

      return {
        kind: 'rotated' as const,
        tokens: {
          accessToken,
          refreshToken: next.token,
          expiresInSeconds: TokenService.accessTokenTtlSeconds,
        },
      };
    });

    if (outcome.kind === 'rotated') return outcome.tokens;
    if (outcome.kind === 'invalid') throw new TokenInvalidError();

    await this.revokeCompromisedFamily(outcome);
    throw new RefreshReuseDetectedError();
  }

  /** Runs in its own transaction so it survives the error thrown to the caller. */
  private async revokeCompromisedFamily(details: {
    familyId: string;
    userId: string;
    sessionId: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await this.repository.revokeFamily(client, details.familyId);
      await this.audit.append(
        {
          actorType: 'system',
          actorId: details.userId,
          action: 'auth.refresh_reuse_detected',
          subjectRef: details.userId,
          payload: { familyId: details.familyId, sessionId: details.sessionId },
        },
        client,
      );
    });
    this.logger.warn(`refresh reuse detected for user ${details.userId}; family revoked`);
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await this.repository.revokeSession(client, sessionId, 'logout');
      await this.audit.append(
        { actorType: 'user', actorId: userId, action: 'auth.logout', subjectRef: sessionId },
        client,
      );
    });
  }

  async logoutEverywhere(userId: string): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const count = await this.repository.revokeAllSessions(client, userId, 'logout_all');
      await this.audit.append(
        {
          actorType: 'user',
          actorId: userId,
          action: 'auth.logout_all',
          subjectRef: userId,
          payload: { sessionsRevoked: count },
        },
        client,
      );
      return count;
    });
  }

  async listSessions(userId: string): Promise<SessionRow[]> {
    return this.repository.listActiveSessions(userId);
  }

  async registerDevice(
    userId: string,
    input: { publicKey: string; label?: string | null },
  ): Promise<{ deviceId: string }> {
    return withTransaction(this.pool, async (client) => {
      const deviceId = await this.repository.registerDevice(client, {
        userId,
        publicKey: input.publicKey,
        label: input.label ?? null,
      });
      await this.audit.append(
        {
          actorType: 'user',
          actorId: userId,
          action: 'auth.device_registered',
          subjectRef: deviceId,
        },
        client,
      );
      return { deviceId };
    });
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.repository.findUserById(userId);
    if (!user) throw new TokenInvalidError();
    return AuthService.toPublicUser(user);
  }

  /**
   * Notified when a session starts.
   *
   * A listener rather than a call into another module, because the only thing that wants
   * this is the risk engine — and the risk engine already depends on auth. Inverting it
   * would make auth depend on risk, and a login that could fail because scoring failed is
   * a worse system than one that occasionally misses a graph edge.
   */
  onSessionStarted(listener: (event: SessionStarted) => void): void {
    this.sessionListeners.push(listener);
  }

  private readonly sessionListeners: Array<(event: SessionStarted) => void> = [];

  private async startSession(
    client: Parameters<typeof this.repository.createSession>[0],
    user: UserRow,
    deviceId: string | null,
    context: RequestContext,
    action: 'login' | 'register',
  ): Promise<AuthTokens> {
    const sessionId = await this.repository.createSession(client, {
      userId: user.id,
      deviceId,
      ip: context.ip,
      country: context.country,
      userAgent: context.userAgent,
    });

    const refresh = this.tokens.createRefreshToken();
    await this.repository.insertRefreshToken(client, {
      familyId: uuidv7(),
      sessionId,
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: TokenService.refreshExpiry(),
    });

    // Fire-and-forget, outside the transaction and never awaited: observation is
    // best-effort by design (see `onSessionStarted`).
    for (const listener of this.sessionListeners) {
      try {
        listener({
          userId: user.id,
          sessionId,
          ...(deviceId ? { deviceId } : {}),
          ...(context.ip ? { ip: context.ip } : {}),
        });
      } catch {
        // A listener must never be able to fail a login.
      }
    }

    const accessToken = this.tokens.issueAccessToken({
      sub: user.id,
      sid: sessionId,
      ...(deviceId ? { did: deviceId } : {}),
      lvl: user.kycLevel,
    });

    await this.audit.append(
      {
        actorType: 'user',
        actorId: user.id,
        action: `auth.${action}`,
        subjectRef: sessionId,
        // Country only — never the IP or user agent, which are personal data (rule 15).
        payload: { country: context.country },
      },
      client,
    );

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresInSeconds: TokenService.accessTokenTtlSeconds,
    };
  }

  /**
   * Account states that may not sign in.
   *
   * `self_excluded` **may** sign in, deliberately (`responsible-gaming.md §5`). A player
   * who has excluded themselves still needs to see that they did, see when it ends, and
   * reach support — and an exclusion they cannot look at is a safety feature that produces
   * support tickets and suspicion in equal measure. Nothing is unlocked by letting them in:
   * every money and play path asks responsible gaming first (ADR-026), and it refuses.
   *
   * `suspended` and `closed` still cannot sign in. A suspension is the risk engine's or an
   * admin's decision rather than the player's, and the refusal carries the support path.
   */
  static assertUsable(user: { status: AccountStatus }): void {
    if (user.status === 'active' || user.status === 'self_excluded') return;
    throw new AccountUnavailableError(user.status);
  }

  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  static toPublicUser(user: UserRow): PublicUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      kycLevel: user.kycLevel,
    };
  }
}
