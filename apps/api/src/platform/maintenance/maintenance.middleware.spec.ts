import type { NextFunction, Request, Response } from 'express';
import { FlagsService } from '../flags/flags.service';
import { MaintenanceMiddleware } from './maintenance.middleware';
import { MaintenanceError } from '../errors/domain-error';

function requestFor(originalUrl: string): Request {
  // `path` is deliberately wrong here: inside middleware Express reports it relative to
  // the mount point, and the middleware must not depend on it.
  return { originalUrl, url: originalUrl, path: '/' } as unknown as Request;
}

async function run(middleware: MaintenanceMiddleware, url: string): Promise<unknown> {
  let passed: unknown = 'not-called';
  const next: NextFunction = (error?: unknown) => {
    passed = error ?? null;
  };
  await middleware.use(requestFor(url), {} as Response, next);
  return passed;
}

describe('MaintenanceMiddleware', () => {
  const middlewareWith = (enabled: boolean): MaintenanceMiddleware =>
    new MaintenanceMiddleware({ isEnabled: () => Promise.resolve(enabled) } as unknown as FlagsService);

  it('passes everything through when maintenance is off', async () => {
    expect(await run(middlewareWith(false), '/api/v1/wallet/balance')).toBeNull();
  });

  it('blocks normal routes with MaintenanceError when on', async () => {
    expect(await run(middlewareWith(true), '/api/v1/wallet/balance')).toBeInstanceOf(MaintenanceError);
  });

  it('lets health probes through during maintenance', async () => {
    expect(await run(middlewareWith(true), '/api/v1/health')).toBeNull();
    expect(await run(middlewareWith(true), '/api/v1/health/ready')).toBeNull();
    expect(await run(middlewareWith(true), '/api/v1/health/')).toBeNull();
  });

  it('cannot be talked past with a query string mentioning health', async () => {
    // A substring check on the URL would wave this through — the kill-switch must not
    // be bypassable by anything the client controls (rule 1).
    expect(await run(middlewareWith(true), '/api/v1/wallet/debit?redirect=/health')).toBeInstanceOf(
      MaintenanceError,
    );
    expect(await run(middlewareWith(true), '/api/v1/wallet/health-check-bypass')).toBeInstanceOf(
      MaintenanceError,
    );
  });
});
