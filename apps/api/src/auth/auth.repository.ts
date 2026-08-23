import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { uuidv7 } from '../platform/ids/uuid-v7';

export type AccountStatus = 'active' | 'suspended' | 'self_excluded' | 'closed';

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  kycLevel: string;
  country: string | null;
}

export interface SessionRow {
  id: string;
  userId: string;
  deviceId: string | null;
  ip: string | null;
  country: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface RefreshTokenRow {
  id: string;
  familyId: string;
  sessionId: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

/** The only place `auth.*` tables are touched (rule 20). */
@Injectable()
export class AuthRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createUser(
    client: PoolClient,
    input: { email: string; displayName: string; passwordHash: string; country: string | null },
  ): Promise<UserRow> {
    const id = uuidv7();
    const { rows } = await client.query<{
      id: string;
      email: string;
      display_name: string;
      status: AccountStatus;
      kyc_level: string;
      country: string | null;
    }>(
      `INSERT INTO auth.users (id, email, display_name, country)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, display_name, status, kyc_level, country`,
      [id, input.email, input.displayName, input.country],
    );
    await client.query('INSERT INTO auth.credentials (user_id, password_hash) VALUES ($1, $2)', [
      id,
      input.passwordHash,
    ]);
    return AuthRepository.toUser(rows[0]!);
  }

  async findUserByEmail(email: string): Promise<(UserRow & { passwordHash: string }) | null> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.email, u.display_name, u.status, u.kyc_level, u.country, c.password_hash
         FROM auth.users u
         JOIN auth.credentials c ON c.user_id = u.id
        WHERE lower(u.email) = lower($1)`,
      [email],
    );
    const row = rows[0];
    return row ? { ...AuthRepository.toUser(row), passwordHash: row.password_hash } : null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query(
      'SELECT id, email, display_name, status, kyc_level, country FROM auth.users WHERE id = $1',
      [id],
    );
    return rows[0] ? AuthRepository.toUser(rows[0]) : null;
  }

  async emailExists(email: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT 1 FROM auth.users WHERE lower(email) = lower($1)', [
      email,
    ]);
    return rows.length > 0;
  }

  async createSession(
    client: PoolClient,
    input: { userId: string; deviceId: string | null; ip: string | null; country: string | null; userAgent: string | null },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO auth.sessions (id, user_id, device_id, ip, country, user_agent)
       VALUES ($1, $2, $3, $4::inet, $5, $6)`,
      [id, input.userId, input.deviceId, input.ip, input.country, input.userAgent],
    );
    return id;
  }

  async findSession(id: string): Promise<SessionRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, device_id, host(ip) AS ip, country, created_at, last_seen_at, revoked_at
         FROM auth.sessions WHERE id = $1`,
      [id],
    );
    return rows[0] ? AuthRepository.toSession(rows[0]) : null;
  }

  async listActiveSessions(userId: string): Promise<SessionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, device_id, host(ip) AS ip, country, created_at, last_seen_at, revoked_at
         FROM auth.sessions
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map(AuthRepository.toSession);
  }

  async touchSession(id: string): Promise<void> {
    await this.pool.query('UPDATE auth.sessions SET last_seen_at = now() WHERE id = $1', [id]);
  }

  async revokeSession(client: PoolClient, id: string, reason: string): Promise<void> {
    await client.query(
      `UPDATE auth.sessions SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, reason],
    );
    // Revoking a session must also kill its refresh chain, or a logged-out client could
    // mint a fresh session from a token it still holds.
    await client.query(
      `UPDATE auth.refresh_tokens SET revoked_at = now()
        WHERE session_id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }

  async revokeAllSessions(client: PoolClient, userId: string, reason: string): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE auth.sessions SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
    await client.query(
      `UPDATE auth.refresh_tokens SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return rowCount ?? 0;
  }

  async insertRefreshToken(
    client: PoolClient,
    input: { familyId: string; sessionId: string; userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO auth.refresh_tokens (id, family_id, session_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.familyId, input.sessionId, input.userId, input.tokenHash, input.expiresAt],
    );
    return id;
  }

  /** Locks the row: two concurrent refreshes must not both succeed. */
  async findRefreshTokenForUpdate(client: PoolClient, tokenHash: string): Promise<RefreshTokenRow | null> {
    const { rows } = await client.query(
      `SELECT id, family_id, session_id, user_id, expires_at, used_at, revoked_at
         FROM auth.refresh_tokens
        WHERE token_hash = $1
          FOR UPDATE`,
      [tokenHash],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          familyId: row.family_id,
          sessionId: row.session_id,
          userId: row.user_id,
          expiresAt: row.expires_at,
          usedAt: row.used_at,
          revokedAt: row.revoked_at,
        }
      : null;
  }

  async markRefreshUsed(client: PoolClient, id: string, replacedBy: string): Promise<void> {
    await client.query('UPDATE auth.refresh_tokens SET used_at = now(), replaced_by = $2 WHERE id = $1', [
      id,
      replacedBy,
    ]);
  }

  /** Revokes an entire refresh family — the response to a detected token replay. */
  async revokeFamily(client: PoolClient, familyId: string): Promise<void> {
    await client.query(
      'UPDATE auth.refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId],
    );
    await client.query(
      `UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'refresh_reuse_detected'
        WHERE id IN (SELECT session_id FROM auth.refresh_tokens WHERE family_id = $1)
          AND revoked_at IS NULL`,
      [familyId],
    );
  }

  async registerDevice(
    client: PoolClient,
    input: { userId: string; publicKey: string; label: string | null },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      'INSERT INTO auth.devices (id, user_id, public_key, label) VALUES ($1, $2, $3, $4)',
      [id, input.userId, input.publicKey, input.label],
    );
    return id;
  }

  async findDevice(id: string): Promise<{ id: string; userId: string; publicKey: string } | null> {
    const { rows } = await this.pool.query(
      'SELECT id, user_id, public_key FROM auth.devices WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
    const row = rows[0];
    return row ? { id: row.id, userId: row.user_id, publicKey: row.public_key } : null;
  }

  async setUserStatus(client: PoolClient, userId: string, status: AccountStatus): Promise<void> {
    await client.query('UPDATE auth.users SET status = $2, updated_at = now() WHERE id = $1', [
      userId,
      status,
    ]);
  }

  private static toUser(row: {
    id: string;
    email: string;
    display_name: string;
    status: AccountStatus;
    kyc_level: string;
    country: string | null;
  }): UserRow {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      kycLevel: row.kyc_level,
      country: row.country,
    };
  }

  private static toSession(row: {
    id: string;
    user_id: string;
    device_id: string | null;
    ip: string | null;
    country: string | null;
    created_at: Date;
    last_seen_at: Date;
    revoked_at: Date | null;
  }): SessionRow {
    return {
      id: row.id,
      userId: row.user_id,
      deviceId: row.device_id,
      ip: row.ip,
      country: row.country,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    };
  }
}
