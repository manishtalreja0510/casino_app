import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthResponse } from '@casino/contracts';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  liveness(): HealthResponse {
    return this.health.liveness();
  }

  /**
   * Readiness returns 503 when this instance cannot serve, so load balancers take it out
   * of rotation. `degraded` still returns 200: the instance is usable.
   */
  @Get('ready')
  async readiness(@Res() res: Response): Promise<void> {
    const result = await this.health.readiness();
    res.status(result.status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK).json(result);
  }
}
