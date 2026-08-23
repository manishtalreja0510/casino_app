import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { apiError, ErrorCode, type ErrorCodeValue } from '@casino/contracts';
import { DomainError } from './domain-error';

/**
 * The single exit path for every error, producing the contract envelope
 * `{ error: { code, message, details?, traceId } }` (docs/03-api/api-conventions.md).
 *
 * Unknown exceptions become INTERNAL with a generic message: the detail goes to the log
 * keyed by the same traceId the client is shown, so support can correlate without the
 * client ever seeing SQL, stack traces, or driver output (rule 15).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const traceId = (request as Request & { traceId?: string }).traceId;

    if (exception instanceof DomainError) {
      this.logger.warn(
        `${request.method} ${request.url} -> ${exception.code} [${traceId ?? 'no-trace'}]`,
      );
      response
        .status(exception.httpStatus)
        .json(apiError(exception.code, exception.message, { details: exception.details, traceId }));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response
        .status(status)
        .json(apiError(this.codeForStatus(status), this.messageFor(exception), { traceId }));
      return;
    }

    // Unknown: log everything, disclose nothing.
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url} [${traceId ?? 'no-trace'}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(apiError(ErrorCode.INTERNAL, 'An unexpected error occurred', { traceId }));
  }

  private codeForStatus(status: number): ErrorCodeValue {
    switch (status) {
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.UNPROCESSABLE_ENTITY:
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.AUTH_FORBIDDEN;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.AUTH_TOKEN_INVALID;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.MAINTENANCE;
      default:
        return ErrorCode.INTERNAL;
    }
  }

  /**
   * Nest's built-in messages are safe (they are framework strings, not our internals),
   * but anything above 500 is reduced to a generic message regardless.
   */
  private messageFor(exception: HttpException): string {
    if (exception.getStatus() >= 500) return 'An unexpected error occurred';
    const body = exception.getResponse();
    if (typeof body === 'string') return body;
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
    return exception.message;
  }
}
