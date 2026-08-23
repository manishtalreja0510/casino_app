import { apiError, ErrorCode } from './errors';

describe('error envelope', () => {
  it('wraps the body under `error` as the API convention requires', () => {
    const e = apiError(ErrorCode.VALIDATION_FAILED, 'bad input');
    expect(e).toEqual({ error: { code: 'VALIDATION_FAILED', message: 'bad input' } });
  });

  it('omits optional fields rather than emitting nulls', () => {
    const e = apiError(ErrorCode.NOT_FOUND, 'missing');
    expect('details' in e.error).toBe(false);
    expect('traceId' in e.error).toBe(false);
  });

  it('carries details and traceId when supplied', () => {
    const e = apiError(ErrorCode.RATE_LIMITED, 'slow down', {
      details: { retryAfterSeconds: 30 },
      traceId: 'abc123',
    });
    expect(e.error.details).toEqual({ retryAfterSeconds: 30 });
    expect(e.error.traceId).toBe('abc123');
  });

  it('keeps every code unique', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });
});
