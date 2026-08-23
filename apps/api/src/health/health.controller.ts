import { Controller, Get } from '@nestjs/common';
import type { HealthResponse, ReadinessResponse } from '@casino/contracts';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  liveness(): HealthResponse {
    return this.health.liveness();
  }

  @Get('ready')
  readiness(): ReadinessResponse {
    return this.health.readiness();
  }
}
