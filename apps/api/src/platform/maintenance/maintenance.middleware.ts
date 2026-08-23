import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { FlagsService } from '../flags/flags.service';
import { FlagKey } from '../flags/flag-keys';
import { MaintenanceError } from '../errors/domain-error';

/** Matches only the health routes themselves, at the end of the path. */
const HEALTH_ROUTE = /\/health(\/ready)?\/?$/;

/**
 * Global kill-switch (rule 16). When `platform.maintenance_mode` is on, every request
 * gets the 503 MAINTENANCE envelope — except health probes, which must keep answering
 * so orchestrators and dashboards can still see the process is alive.
 *
 * Two details matter for correctness:
 *  - `originalUrl` is used, not `req.path`: inside middleware Express reports the path
 *    relative to the mount point, so `req.path` is not the route the client asked for.
 *  - The query string is stripped before matching, so a request like
 *    `/api/v1/wallet/debit?redirect=/health` cannot talk its way past the kill-switch.
 */
@Injectable()
export class MaintenanceMiddleware implements NestMiddleware {
  constructor(private readonly flags: FlagsService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const pathname = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';

    if (HEALTH_ROUTE.test(pathname)) {
      next();
      return;
    }
    if (await this.flags.isEnabled(FlagKey.MAINTENANCE_MODE)) {
      next(new MaintenanceError());
      return;
    }
    next();
  }
}
