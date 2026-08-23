import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { REDACTED_PATHS, REDACTION_PLACEHOLDER } from './redaction';

/**
 * Structured JSON logging (docs/07-operations/observability.md).
 *
 * Bodies are never logged — only method, path, status, duration, and opaque ids.
 * Redaction is configured centrally in redaction.ts and covers headers too.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isDev = config.get<string>('APP_ENV') === 'dev';
        return {
          pinoHttp: {
            level: config.get<string>('LOG_LEVEL') ?? (isDev ? 'debug' : 'info'),
            redact: { paths: REDACTED_PATHS, censor: REDACTION_PLACEHOLDER },
            // Pretty output locally; strict JSON everywhere else so log shippers can parse it.
            transport: isDev ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
            customProps: (req) => ({ traceId: (req as Request & { traceId?: string }).traceId }),
            // Only the fields we intend to keep — not the whole request object.
            serializers: {
              req: (req: { method: string; url: string; id?: string }) => ({
                method: req.method,
                url: req.url,
              }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
            autoLogging: {
              ignore: (req) => (req.url ?? '').includes('/health'),
            },
          },
        };
      },
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
