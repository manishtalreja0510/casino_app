import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '@casino/contracts';
import { AllExceptionsFilter } from './platform/errors/all-exceptions.filter';

/**
 * The single place application-wide wiring is configured.
 *
 * `main.ts` and the e2e tests both call this, so a test can never pass against a
 * differently-configured app than the one that actually runs — that drift is how
 * "green tests, broken boot" happens.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  return app;
}
