import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const service = new HealthService({ get: () => 'dev' } as unknown as ConfigService);

  it('reports liveness with environment and a whole-second uptime', () => {
    const result = service.liveness();
    expect(result.status).toBe('ok');
    expect(result.environment).toBe('dev');
    expect(Number.isInteger(result.uptimeSeconds)).toBe(true);
  });

  it('reports readiness with no dependencies until P1 wires them', () => {
    expect(service.readiness()).toEqual({ status: 'ok', dependencies: [] });
  });

  it('falls back to dev when APP_ENV is unset', () => {
    const bare = new HealthService({ get: () => undefined } as unknown as ConfigService);
    expect(bare.liveness().environment).toBe('dev');
  });
});
