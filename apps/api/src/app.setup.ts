import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@casino/contracts';

/**
 * The single place application-wide wiring is configured.
 *
 * `main.ts` and the e2e tests both call this, so a test can never pass against a
 * differently-configured app than the one that actually runs — that drift is how
 * "green tests, broken boot" happens.
 *
 * Global validation, the error-envelope filter, and security middleware are added
 * here in P1, driven by the contract schemas (docs/03-api/api-principles.md).
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.enableShutdownHooks();
  return app;
}
