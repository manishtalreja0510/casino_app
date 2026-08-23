# Phase 03 — Auth & identity

## 1. Phase overview
Accounts, sessions and the trust plumbing every money and game action rides on. Roadmap: `../MASTER_ROADMAP.md` §P3. Every ledger row from P4 needs an authenticated, device-bound principal, so this precedes the wallet.

## 2. Current status
`COMPLETE` — 2026-08-23.

## 3. Objective
A user can register, log in, and hold a session that survives token rotation; every request carries a verifiable identity; financial-class requests additionally carry a device signature; and every auth event is audit-logged.

## 4. Dependencies
P1 (config, errors, audit, flags, rate limiter, database) and P2 (app shell, api_client, ui_kit) — both COMPLETE and verified via `pnpm verify:all`.

## 5. Preconditions
Local Postgres/Redis running; migration 0001 applied.

## 6. Existing-code analysis
P1 provides `withTransaction`, `AuditService` (transaction-participating), `RateLimiter`, `DomainError` + filter, and `uuidv7`. P2 provides `CasinoApiClient` (health only), `AppInput`/`AppButton`, and the router. This phase extends all of them rather than adding parallel machinery.

## 7. Scope
1. **Schema** (`auth` schema): `users`, `credentials`, `devices`, `sessions`, `refresh_tokens` with family/rotation columns.
2. **Registration/login** — email + password, Argon2id (`@node-rs/argon2`), timing-safe failure.
3. **Token model** — ES256 access JWT (10 min, `kid`-rotatable) + opaque 256-bit refresh token, hashed at rest, single-use, 30-day sliding.
4. **Refresh rotation with reuse detection** — replaying a used token revokes the entire family and audits it.
5. **Device binding** — register a P-256 public key; sessions bound to a device.
6. **Request signing** — detached signature over `method|path|bodyHash|timestamp|nonce` on financial-class endpoints, with a Redis nonce cache for replay protection and a bounded clock-skew window.
7. **Session management** — PG truth + Redis cache; revoke one / all; `GET /auth/sessions`.
8. **Account states** — `active | suspended | self_excluded | closed`, enforced at login and on every authenticated request.
9. **Rate limiting** — auth class applied to login/register/refresh, per IP and per identifier.
10. **Geo scaffold** — record request country on the session (enforcement stays off until licensing).
11. **KYC level field** — every user carries `kyc_level` defaulting to `L0` (OQ-03 deferred; the field exists so P16 slots in without touching call sites).
12. **Flutter** — auth state layer, secure token storage, login/register screens, session bootstrap and logout.

## 8. Out of scope
Password reset by email (no mail provider yet — P11), player 2FA (OQ-13), certificate pinning (deferred with the real endpoint), social/phone login, admin auth (P12).

## 9. Architecture considerations
Implements `../02-domains/authentication.md` and ADR-013. The `auth` module owns only `auth.*` tables (rule 20). Guards live in the module and are applied by route class, deny-by-default.

## 10. Database changes
Migration `0002_auth.sql` — five tables, indexes on lookup paths, `CHECK` on account state, unique on `lower(email)`.

## 11. Backend changes
New `auth` module: controller, service, repository, token service, device service, signing verifier, guards (`AccessTokenGuard`, `SignedRequestGuard`), and DTOs from contracts.

## 12. Flutter changes
`features/auth` (login, register screens), `authProvider` state, `SecureTokenStore` (flutter_secure_storage), API client auth methods with automatic refresh, router redirect on auth state.

## 13. API changes
`POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/sessions`, `POST /auth/sessions/revoke`, `POST /auth/devices`. New error codes already exist in contracts.

## 14. WebSocket changes
None — WS tickets arrive in P5, but the token model here is what they will be issued from.

## 15. Security considerations (MANDATORY)
- **Password storage**: Argon2id with library defaults (19 MiB, t=2, p=1); never logged, never returned.
- **Timing**: login runs a dummy verify when the user does not exist, so response time does not disclose account existence.
- **Refresh reuse detection**: a replayed refresh token revokes the family and writes an audit entry — the canonical signal of a stolen token.
- **Signature replay**: nonce cached in Redis for the skew window; a repeated nonce is rejected. Fails **closed** — if the nonce cache is unavailable the signed request is refused (unlike the rate limiter, this one protects money).
- **No PII in logs or audit payloads**: user ids only, never emails (rule 15). Audit `subject_ref` carries the user id.
- **Account state** is checked on every authenticated request, not only at login, so a suspension takes effect immediately.
- **Tokens**: access tokens carry the minimum claims (`sub`, `sid`, `did`, `lvl`); no email, no name.
- Checklist `../04-security/security-checklist.md` §A and §B.

## 16. Edge cases
Duplicate registration; case/whitespace in emails; login while suspended or self-excluded; refresh after logout; concurrent refresh from two app instances; clock skew on signatures; body-hash mismatch; unknown device; session revoked mid-request; Redis down (sessions fall back to PG; signed requests refused).

## 17. Testing strategy
Unit: token issue/verify, signature verification incl. tamper and skew, password hashing, account-state rules. Integration (real PG/Redis): full register→login→refresh→logout journey, reuse detection revoking a family, rate-limited login, signed-request acceptance/rejection, session listing and revocation, audit rows written for each. Flutter: auth provider state machine, token storage, screens.

## 18. Implementation plan
Migration → token/password services → repository → service → guards → controller → tests → Flutter → verify.

## 19. Rollback / recovery
Additive migration; `DROP SCHEMA auth CASCADE` while no production data exists. Feature-flag not required — nothing prior depends on these routes.

## 20. Acceptance criteria
1. Register → login → authenticated `GET /auth/me` works end to end against the real database.
2. A refresh token cannot be used twice; the second attempt revokes the family and is audited.
3. A tampered or replayed signed request is rejected.
4. A suspended account is refused on the next request, not merely at next login.
5. Auth endpoints are rate-limited per IP and identifier.
6. No password, token, or email appears in any log or audit payload.
7. `pnpm verify:all` green.

## 21. Definition of done
Acceptance met · tests green, no skips · analyze/lint clean · security checklist closed · docs + `progress.md` + flow map updated · completion report written.

## 22. Completion report

**Delivered as planned.** All 12 scope items: `auth` schema (5 tables), Argon2id credentials, ES256 access tokens, single-use rotating refresh tokens with family revocation, device registration, request-signature verification, session management, account states, auth-class rate limiting, the geo scaffold, the `kyc_level` field at L0, and the Flutter auth layer with a gated router.

**A real security bug, found by an integration test.** Reuse detection revoked the token family *inside* the transaction that then threw `RefreshReuseDetectedError` — and the throw rolled the revocation back. A stolen refresh chain would have received a 401 while remaining fully alive. The fix splits it: the first transaction classifies and commits (releasing its `FOR UPDATE` lock), then a second transaction performs the revocation and audit before the error is raised. The two cannot be nested, because a second transaction touching the same locked row deadlocks against the first. The test now asserts what matters — after a replay, the *legitimate* holder's newest token is dead too.

**`jose` v6 is ESM-only**, so a CommonJS Nest build cannot require it — the same trap `uuid` v14 set in P1. ES256 JWT is implemented natively over `node:crypto` (~120 lines) with `dsaEncoding: 'ieee-p1363'`, which is exactly the JWS signature format. The tests cover the two classic forgeries: `alg: none`, and HMAC-signing with the public key as the shared secret. Both are rejected, because the algorithm is fixed by us and never read from the token.

**Deliberate design points.**
- **Sessions are checked on every request, not just at token issue.** That is two indexed reads per request, and it buys immediate revocation: logout, family revocation, and suspension all take effect now rather than whenever a 10-minute token happens to expire. Tests assert all three.
- **Login is not an account-existence oracle.** An unknown email runs a real Argon2id verification against a decoy hash, and wrong-password and unknown-account return byte-identical errors (only the traceId differs). Registration refuses duplicates without saying the address is taken.
- **Signed requests fail closed.** If the Redis nonce cache is unavailable the request is refused — the opposite of the rate limiter, which fails open. Replay protection guards money; rate limiting is defence in depth.
- **Guards are global**, so authentication is deny-by-default: a new controller is protected the moment it exists, and `@Public()` is required to opt out. Health endpoints carry it.

**Test evidence.** 74 unit + 33 integration (+18 Flutter) green, no skips. Security-relevant assertions: refresh reuse revokes the family and audits it; logout kills a still-valid access token; suspension and self-exclusion apply on the next request with distinct codes; signature tampering on body, path, key and timestamp all rejected; nonce replay rejected; rate limiting returns 429 with a retry hint; validation errors name fields but never echo submitted values; audit payloads contain no email; the stored credential is an Argon2id hash containing no plaintext.

**The rate limiter proved itself unintentionally** — the integration suite tripped its own per-IP limit, which is the limiter working. Buckets are cleared between tests, and one test now exercises the limit deliberately.

## 23. Known limitations
- **No password reset** — needs an email provider (P11). A user who forgets their password currently has no self-service path.
- **Request signing is implemented and tested but not yet applied to any route**, because no financial endpoint exists until P4. The guard and `@SignedRequest()` decorator are ready; P4 attaches them.
- **Device registration does not verify possession of the private key.** A client could register a public key it does not hold; it would then be unable to sign, so this is a usability rather than a security gap — but a challenge-response at registration is the correct fix (noted as debt).
- **No player 2FA** (OQ-13) and no step-up authentication for sensitive actions.
- **Geo is recorded, not enforced** — by design until licensing defines the rules (rule 13).
- **Access tokens are not revocable in themselves**; revocation works because the session is re-checked per request. If that check is ever removed as an optimisation, revocation silently gains a 10-minute window.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| Device registration lacks proof-of-possession | A key can be registered that the client cannot sign with | P4, alongside the first signed endpoint |
| Session/user lookups on every request are uncached | Two indexed reads per request; fine now, matters at load | P14, with a short Redis cache and explicit invalidation on revoke |
| No key-rotation runbook exercised | `kid` is emitted but rotation is untested | P13/P14 |
| Password reset absent | Support burden | P11 |
| Argon2 parameters not tuned to production hardware | Defaults are sane, not measured | P14 |

## 25. Next-phase dependencies
P4 gets an authenticated principal and the signed-request guard for financial endpoints. P5 issues WS tickets from this token model.
