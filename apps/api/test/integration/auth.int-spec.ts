import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Pool } from 'pg';
import Redis from 'ioredis';
import { API_PREFIX } from '@casino/contracts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { ensureMigrated, testPool, TEST_REDIS_URL } from './db';

/** Unique per run so repeated runs do not collide on the email unique index. */
const uniqueEmail = (tag: string) => `p3-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

describe('auth (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  const password = 'a-sufficiently-long-password';

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);
    redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  // Every test in this file shares one source IP, so without this they would collectively
  // trip the auth rate limit — which is the limiter working correctly. Buckets are cleared
  // per test; the limit itself is exercised deliberately in its own test below.
  beforeEach(async () => {
    const keys = await redis.keys('rl:auth:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
    await pool.end();
  });

  const api = () => request(app.getHttpServer());

  async function register(email: string) {
    const response = await api()
      .post(`${API_PREFIX}/auth/register`)
      .send({ email, password, displayName: 'Test Player' })
      .expect(201);
    return response.body as { accessToken: string; refreshToken: string; user: { id: string } };
  }

  it('registers, authenticates, and returns the user', async () => {
    const email = uniqueEmail('register');
    const registered = await register(email);
    expect(registered.accessToken).toEqual(expect.any(String));
    expect(registered.user.id).toEqual(expect.any(String));

    const me = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('authorization', `Bearer ${registered.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe(email);
    // OQ-03: verification is deferred, so every account sits at L0.
    expect(me.body.kycLevel).toBe('L0');
  });

  it('denies unauthenticated access by default', async () => {
    const response = await api().get(`${API_PREFIX}/auth/me`).expect(401);
    expect(response.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('refuses a duplicate email without revealing that it exists', async () => {
    const email = uniqueEmail('dup');
    await register(email);
    const response = await api()
      .post(`${API_PREFIX}/auth/register`)
      .send({ email: email.toUpperCase(), password, displayName: 'Impostor' })
      .expect(409);
    // Deliberately not "email already registered".
    expect(response.body.error.message).not.toMatch(/already/i);
  });

  it('logs in and rejects a wrong password with the same message as an unknown account', async () => {
    const email = uniqueEmail('login');
    await register(email);

    await api().post(`${API_PREFIX}/auth/login`).send({ email, password }).expect(201);

    const wrongPassword = await api()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email, password: 'wrong-but-long-enough' })
      .expect(401);
    const unknownAccount = await api()
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: uniqueEmail('ghost'), password })
      .expect(401);

    // Same code and message; only the per-request traceId differs.
    expect(wrongPassword.body.error.code).toBe(unknownAccount.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
  });

  it('rotates refresh tokens and invalidates the old one', async () => {
    const registered = await register(uniqueEmail('rotate'));

    const rotated = await api()
      .post(`${API_PREFIX}/auth/refresh`)
      .send({ refreshToken: registered.refreshToken })
      .expect(201);
    expect(rotated.body.refreshToken).not.toBe(registered.refreshToken);

    // The new token works.
    await api()
      .post(`${API_PREFIX}/auth/refresh`)
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(201);
  });

  it('DETECTS refresh reuse and revokes the whole family', async () => {
    const registered = await register(uniqueEmail('reuse'));

    const rotated = await api()
      .post(`${API_PREFIX}/auth/refresh`)
      .send({ refreshToken: registered.refreshToken })
      .expect(201);

    // Replaying the consumed token: the signal that two parties hold the chain.
    const replay = await api()
      .post(`${API_PREFIX}/auth/refresh`)
      .send({ refreshToken: registered.refreshToken })
      .expect(401);
    expect(replay.body.error.code).toBe('AUTH_REFRESH_REUSE_DETECTED');

    // The legitimate holder's newest token is revoked too — the whole family dies.
    await api()
      .post(`${API_PREFIX}/auth/refresh`)
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);

    // And the access token stops working, because its session was revoked.
    await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('authorization', `Bearer ${registered.accessToken}`)
      .expect(401);

    const { rows } = await pool.query(
      "SELECT 1 FROM audit.audit_log WHERE action = 'auth.refresh_reuse_detected' LIMIT 1",
    );
    expect(rows).toHaveLength(1);
  });

  it('ends the session on logout, immediately', async () => {
    const registered = await register(uniqueEmail('logout'));
    await api()
      .post(`${API_PREFIX}/auth/logout`)
      .set('authorization', `Bearer ${registered.accessToken}`)
      .expect(201);

    // The access token has minutes of validity left, but the session is gone — which is
    // exactly why the guard re-checks the session on every request.
    await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('authorization', `Bearer ${registered.accessToken}`)
      .expect(401);

    await api()
      .post(`${API_PREFIX}/auth/refresh`)
      .send({ refreshToken: registered.refreshToken })
      .expect(401);
  });

  it('applies a suspension to the very next request, not the next login', async () => {
    const registered = await register(uniqueEmail('suspend'));
    await pool.query("UPDATE auth.users SET status = 'suspended' WHERE id = $1", [registered.user.id]);

    const response = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('authorization', `Bearer ${registered.accessToken}`)
      .expect(403);
    expect(response.body.error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  it('reports self-exclusion distinctly from suspension (rule 12)', async () => {
    const registered = await register(uniqueEmail('rg'));
    await pool.query("UPDATE auth.users SET status = 'self_excluded' WHERE id = $1", [registered.user.id]);

    const response = await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('authorization', `Bearer ${registered.accessToken}`)
      .expect(403);
    expect(response.body.error.code).toBe('RG_SELF_EXCLUDED');
  });

  it('lists and revokes sessions', async () => {
    const email = uniqueEmail('sessions');
    const first = await register(email);
    await api().post(`${API_PREFIX}/auth/login`).send({ email, password }).expect(201);

    const listed = await api()
      .get(`${API_PREFIX}/auth/sessions`)
      .set('authorization', `Bearer ${first.accessToken}`)
      .expect(200);
    expect(listed.body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(listed.body.sessions.some((s: { current: boolean }) => s.current)).toBe(true);

    await api()
      .post(`${API_PREFIX}/auth/sessions/revoke`)
      .set('authorization', `Bearer ${first.accessToken}`)
      .send({ all: true })
      .expect(201);

    await api()
      .get(`${API_PREFIX}/auth/me`)
      .set('authorization', `Bearer ${first.accessToken}`)
      .expect(401);
  });

  it('rate-limits repeated login attempts (credential stuffing defence)', async () => {
    const email = uniqueEmail('ratelimit');
    await register(email);

    // The auth class allows 10 per minute per IP and per identifier; the 11th must be refused.
    const attempts = await Promise.all(
      Array.from({ length: 14 }, () =>
        api().post(`${API_PREFIX}/auth/login`).send({ email, password: 'wrong-but-long-enough' }),
      ),
    );

    const limited = attempts.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]!.body.error.code).toBe('RATE_LIMITED');
    expect(limited[0]!.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('validates input without echoing the submitted values (rule 15)', async () => {
    const response = await api()
      .post(`${API_PREFIX}/auth/register`)
      .send({ email: 'not-an-email', password: 'short', displayName: 'x' })
      .expect(422);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const serialised = JSON.stringify(response.body);
    expect(serialised).toContain('email');
    expect(serialised).not.toContain('short');
  });

  it('never stores or returns the password', async () => {
    const email = uniqueEmail('nopass');
    const registered = await register(email);
    expect(JSON.stringify(registered)).not.toContain(password);

    const { rows } = await pool.query(
      'SELECT password_hash FROM auth.credentials WHERE user_id = $1',
      [registered.user.id],
    );
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(password);
  });

  it('writes audit entries without personal data (rule 15)', async () => {
    const email = uniqueEmail('audit');
    const registered = await register(email);

    const { rows } = await pool.query(
      "SELECT payload::text AS payload FROM audit.audit_log WHERE action = 'auth.register' AND actor_id = $1",
      [registered.user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).not.toContain(email);
  });
});
