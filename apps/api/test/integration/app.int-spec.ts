import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { API_PREFIX } from '@casino/contracts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { FlagsService } from '../../src/platform/flags/flags.service';
import { FlagKey } from '../../src/platform/flags/flag-keys';
import { ensureMigrated, testPool } from './db';

/** Full application against real PostgreSQL and Redis. */
describe('application (integration)', () => {
  let app: INestApplication;
  let flags: FlagsService;

  beforeAll(async () => {
    const pool = testPool();
    await ensureMigrated(pool);
    await pool.end();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    flags = app.get(FlagsService);
  });

  afterAll(async () => {
    await flags.set(FlagKey.MAINTENANCE_MODE, false, 'integration-test-cleanup');
    await app.close();
  });

  it('reports liveness with version, environment and uptime', async () => {
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/health`).expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toEqual(expect.any(String));
    expect(res.body.environment).toEqual(expect.any(String));
    expect(Number.isInteger(res.body.uptimeSeconds)).toBe(true);
  });

  it('serves nothing outside the versioned prefix', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('reports per-dependency readiness', async () => {
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/health/ready`).expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies).toEqual(
      expect.arrayContaining([
        { name: 'postgres', status: 'ok' },
        { name: 'redis', status: 'ok' },
      ]),
    );
  });

  it('returns the contract error envelope for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/does-not-exist`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.traceId).toEqual(expect.any(String));
    // Nothing internal leaks: no stack, no SQL, no framework internals.
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(|SELECT |node_modules/);
  });

  it('echoes a trace id header for support correlation', async () => {
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/health`).expect(200);
    expect(res.headers['x-trace-id']).toEqual(expect.any(String));
  });

  it('serves 503 MAINTENANCE when the kill-switch is on, while health keeps answering', async () => {
    await flags.set(FlagKey.MAINTENANCE_MODE, true, 'integration-test');
    try {
      const blocked = await request(app.getHttpServer()).get(`${API_PREFIX}/anything`).expect(503);
      expect(blocked.body.error.code).toBe('MAINTENANCE');

      // Health must stay reachable so orchestrators and dashboards still work.
      await request(app.getHttpServer()).get(`${API_PREFIX}/health`).expect(200);
      await request(app.getHttpServer()).get(`${API_PREFIX}/health/ready`).expect(200);
    } finally {
      await flags.set(FlagKey.MAINTENANCE_MODE, false, 'integration-test');
    }
  });

  it('resumes serving once the kill-switch is off', async () => {
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/health`).expect(200);
    expect(res.body.status).toBe('ok');
  });
});
