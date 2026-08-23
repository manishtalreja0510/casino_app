import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { HealthService } from './health.service';

const config = { get: () => 'dev' } as unknown as ConfigService;
const okPool = { query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) } as unknown as Pool;
const okRedis = { ping: () => Promise.resolve('PONG') } as unknown as Redis;
const deadPool = { query: () => Promise.reject(new Error('ECONNREFUSED')) } as unknown as Pool;
const deadRedis = { ping: () => Promise.reject(new Error('ECONNREFUSED')) } as unknown as Redis;

describe('HealthService', () => {
  it('reports liveness without touching dependencies', () => {
    const result = new HealthService(config, deadPool, deadRedis).liveness();
    // Liveness must stay green during a database outage, or orchestrators kill healthy pods.
    expect(result.status).toBe('ok');
    expect(result.environment).toBe('dev');
    expect(Number.isInteger(result.uptimeSeconds)).toBe(true);
  });

  it('reports ok when both dependencies answer', async () => {
    const result = await new HealthService(config, okPool, okRedis).readiness();
    expect(result.status).toBe('ok');
    expect(result.dependencies).toEqual([
      { name: 'postgres', status: 'ok' },
      { name: 'redis', status: 'ok' },
    ]);
  });

  it('is DOWN without PostgreSQL — there is no serving without the source of truth', async () => {
    const result = await new HealthService(config, deadPool, okRedis).readiness();
    expect(result.status).toBe('down');
    expect(result.dependencies).toContainEqual({ name: 'postgres', status: 'down' });
  });

  it('is only DEGRADED without Redis — flags fall back to PostgreSQL (rule 7)', async () => {
    const result = await new HealthService(config, okPool, deadRedis).readiness();
    expect(result.status).toBe('degraded');
    expect(result.dependencies).toContainEqual({ name: 'redis', status: 'down' });
  });
});
