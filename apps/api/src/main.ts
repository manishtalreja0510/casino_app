import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { API_PREFIX } from '@casino/contracts';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule, { bufferLogs: true }));
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);

  new Logger('Bootstrap').log(
    `API listening on port ${port} (${config.get<string>('APP_ENV')}) at ${API_PREFIX}`,
  );
}

// A failed boot must exit non-zero — a half-started API is worse than a dead one.
bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
