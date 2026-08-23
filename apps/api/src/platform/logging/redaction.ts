/**
 * Fields that must never reach a log line (rule 15: no PII or secrets in logs).
 *
 * pino redacts by path, so every shape a value can arrive in needs listing. This list is
 * deliberately broad — an over-redacted log is an inconvenience, a leaked credential is
 * an incident. Extend it whenever a new sensitive field is introduced; the test in
 * redaction.spec.ts asserts each entry actually disappears.
 */
export const REDACTED_PATHS: string[] = [
  // credentials and tokens, at the root and one level down
  'password',
  '*.password',
  'currentPassword',
  'newPassword',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'signature',
  '*.signature',
  'privateKey',
  '*.privateKey',

  // personal data — we log opaque ids instead
  'email',
  '*.email',
  'phone',
  '*.phone',
  'dateOfBirth',
  '*.dateOfBirth',
  'fullName',
  '*.fullName',
  'address',
  '*.address',
  'documentNumber',
  '*.documentNumber',

  // request/response headers that carry credentials
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signature"]',
  'req.headers["x-device-signature"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

export const REDACTION_PLACEHOLDER = '[redacted]';
