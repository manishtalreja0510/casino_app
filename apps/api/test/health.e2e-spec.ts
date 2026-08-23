import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { API_PREFIX } from '@casino/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Same wiring as main.ts — see src/app.setup.ts.
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it(`GET ${API_PREFIX}/health returns a well-formed liveness response`, async () => {
    const response = await request(app.getHttpServer()).get(`${API_PREFIX}/health`).expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.environment).toBeDefined();
    expect(Number.isInteger(response.body.uptimeSeconds)).toBe(true);
  });

  it(`GET ${API_PREFIX}/health/ready returns readiness`, async () => {
    const response = await request(app.getHttpServer())
      .get(`${API_PREFIX}/health/ready`)
      .expect(200);
    expect(response.body).toEqual({ status: 'ok', dependencies: [] });
  });

  it('serves nothing outside the versioned prefix', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });
});
