import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ErrorCode } from '@casino/contracts';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { DomainError, RateLimitedError, ValidationError } from './domain-error';

function makeHost(): { host: ArgumentsHost; body: () => unknown; status: () => number } {
  let capturedBody: unknown;
  let capturedStatus = 0;
  const response = {
    status(code: number) {
      capturedStatus = code;
      return this;
    },
    json(payload: unknown) {
      capturedBody = payload;
      return this;
    },
  };
  const request = { method: 'GET', url: '/api/v1/test', traceId: 'trace-abc' };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, body: () => capturedBody, status: () => capturedStatus };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps a domain error to its contract code, status and details', () => {
    const { host, body, status } = makeHost();
    filter.catch(new ValidationError('bad input', { field: 'amount' }), host);
    expect(status()).toBe(422);
    expect(body()).toEqual({
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'bad input',
        details: { field: 'amount' },
        traceId: 'trace-abc',
      },
    });
  });

  it('carries retry information on rate limiting', () => {
    const { host, body, status } = makeHost();
    filter.catch(new RateLimitedError(30), host);
    expect(status()).toBe(429);
    expect((body() as { error: { details: unknown } }).error.details).toEqual({ retryAfterSeconds: 30 });
  });

  it('maps framework exceptions to contract codes', () => {
    const { host, body, status } = makeHost();
    filter.catch(new NotFoundException(), host);
    expect(status()).toBe(404);
    expect((body() as { error: { code: string } }).error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('never leaks internals for unknown exceptions (rule 15)', () => {
    const { host, body, status } = makeHost();
    const leaky = new Error('duplicate key value violates unique constraint "users_email_key"');
    leaky.stack = 'Error: ...\n    at Object.<anonymous> (/app/src/secret.ts:1:1)';

    filter.catch(leaky, host);

    expect(status()).toBe(500);
    const serialised = JSON.stringify(body());
    expect(serialised).not.toContain('users_email_key');
    expect(serialised).not.toContain('secret.ts');
    expect(body()).toEqual({
      error: { code: ErrorCode.INTERNAL, message: 'An unexpected error occurred', traceId: 'trace-abc' },
    });
  });

  it('reduces 5xx framework exceptions to a generic message', () => {
    const { host, body } = makeHost();
    filter.catch(new HttpException('database cluster unreachable at 10.0.0.5', HttpStatus.BAD_GATEWAY), host);
    expect(JSON.stringify(body())).not.toContain('10.0.0.5');
  });

  it('preserves a custom domain error subclass', () => {
    class InsufficientFundsError extends DomainError {
      constructor() {
        super(ErrorCode.WALLET_INSUFFICIENT_FUNDS, 'Insufficient funds', 409);
      }
    }
    const { host, body, status } = makeHost();
    filter.catch(new InsufficientFundsError(), host);
    expect(status()).toBe(409);
    expect((body() as { error: { code: string } }).error.code).toBe(ErrorCode.WALLET_INSUFFICIENT_FUNDS);
  });
});
