import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthResponse, ReadinessResponse } from '@casino/contracts';

/** Version reported by the health endpoint; replaced by the build-stamped value in CI (P13). */
export const APP_VERSION = '0.0.0';

@Injectable()
export class HealthService {
  constructor(private readonly config: ConfigService) {}

  liveness(): HealthResponse {
    return {
      status: 'ok',
      version: APP_VERSION,
      environment: this.config.get<string>('APP_ENV') ?? 'dev',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  /**
   * Readiness. There are no dependencies to check yet — PostgreSQL and Redis
   * checks are added in P1 when they are actually wired, so this cannot report
   * a health it has not verified.
   */
  readiness(): ReadinessResponse {
    return { status: 'ok', dependencies: [] };
  }
}
