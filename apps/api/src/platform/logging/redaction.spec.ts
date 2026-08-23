import pino from 'pino';
import { Writable } from 'node:stream';
import { REDACTED_PATHS, REDACTION_PLACEHOLDER } from './redaction';

/**
 * Rule 15: no PII or secrets in logs. This test asserts the redaction config actually
 * removes each sensitive field — a list of paths nobody verifies is not a control.
 */
describe('log redaction', () => {
  function captureLog(payload: Record<string, unknown>): string {
    let output = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        output += chunk.toString();
        cb();
      },
    });
    const logger = pino({ redact: { paths: REDACTED_PATHS, censor: REDACTION_PLACEHOLDER } }, sink);
    logger.info(payload, 'test');
    return output;
  }

  it('redacts credentials at the root', () => {
    const output = captureLog({
      password: 'hunter2',
      token: 'eyJhbGciOi.secret',
      refreshToken: 'rt_live_abc',
      apiKey: 'sk_live_xyz',
      secret: 'shhh',
      signature: 'sig_abc',
      privateKey: '-----BEGIN PRIVATE KEY-----',
    });

    for (const value of ['hunter2', 'eyJhbGciOi.secret', 'rt_live_abc', 'sk_live_xyz', 'shhh', 'sig_abc', 'BEGIN PRIVATE KEY']) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain(REDACTION_PLACEHOLDER);
  });

  it('redacts personal data at the root', () => {
    const output = captureLog({
      email: 'player@example.com',
      phone: '+15551234567',
      dateOfBirth: '1990-01-01',
      fullName: 'A Real Person',
      address: '1 Example Street',
      documentNumber: 'P1234567',
    });

    for (const value of ['player@example.com', '+15551234567', '1990-01-01', 'A Real Person', '1 Example Street', 'P1234567']) {
      expect(output).not.toContain(value);
    }
  });

  it('redacts nested one level down, where request payloads land', () => {
    const output = captureLog({ body: { password: 'hunter2', email: 'player@example.com' } });
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('player@example.com');
  });

  it('redacts credential-bearing request headers', () => {
    const output = captureLog({
      req: { headers: { authorization: 'Bearer secret-token', cookie: 'sid=abc123' } },
    });
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('sid=abc123');
  });

  it('keeps non-sensitive fields so logs stay useful', () => {
    const output = captureLog({ userId: '018f2b1c-0000-7000-8000-000000000000', action: 'wallet.debit' });
    expect(output).toContain('018f2b1c-0000-7000-8000-000000000000');
    expect(output).toContain('wallet.debit');
  });
});
