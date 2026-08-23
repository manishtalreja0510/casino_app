# REST API Conventions

The concrete rulebook for every REST endpoint. Principles: `api-principles.md`. WS rules: `websocket-conventions.md`. All shapes below are defined normatively in `packages/contracts` (OpenAPI + JSON Schema); this doc states the conventions the contracts must follow.

## 1. Base paths & resources

- Player API: **`/api/v1`**. Admin API: **`/admin/v1`** (same NestJS process, separate module, guards, and OpenAPI document — never cross-mounted).
- Resource naming: plural kebab-case nouns; path params are UUIDv7.
  - `GET /api/v1/wallet/transactions` · `GET /api/v1/tables/{tableId}` · `POST /api/v1/auth/ws-ticket`
- Nesting max two levels (`/tables/{tableId}/seats`); deeper relations become top-level resources with filters.
- Non-CRUD operations are explicit verb sub-resources, always `POST`: `POST /api/v1/wallet/faucet`, `POST /api/v1/matches/{matchId}/leave`. No RPC soup: if a verb recurs across resources, it's a smell — model the state machine instead.
- Method semantics: `GET` safe/cacheable-never-mutating, `POST` create/action, `PUT` full replace (rare), `PATCH` partial update (JSON merge semantics per endpoint schema), `DELETE` idempotent removal. `GET`/`DELETE` never take bodies.

## 2. Representation rules

| Concern | Rule |
|---|---|
| JSON casing | `camelCase` keys everywhere (requests, responses, errors). No snake_case leaks from the DB layer. |
| IDs | UUIDv7 strings, lowercase hyphenated. Client never fabricates server entity ids (client-generated ids exist only where specified: `Idempotency-Key`, WS `actionId`). |
| Money | Always the object `{"amount": <integer minor units>, "currency": "<code>"}` — e.g. `{"amount": 1250, "currency": "TST"}`. Never bare numbers, never floats, never strings of decimals (rule 4). Formatting is a client concern via currency metadata. |
| Timestamps | RFC3339 UTC with `Z` suffix, millisecond precision (`2026-08-23T10:15:04.211Z`). No epoch numbers in payloads (headers like `X-Timestamp` excepted per signing spec). |
| Enums | UPPER_SNAKE string values; clients MUST tolerate unknown values (render fallback, don't crash) — enums grow additively. |
| Nulls | Absent and `null` are equivalent; contracts mark optionality explicitly. No `undefined`-vs-`null` semantics. |
| Unknown fields | Rejected in requests (strict input validation at the edge); tolerated in responses by clients (additive evolution). |

## 3. Pagination, filtering, sorting

- **Cursor-based only.** Offset pagination is forbidden (unstable under writes, invites table scans).
  - Request: `?limit=25&cursor=<opaque>`. `limit` default 25, hard cap 100 (per-endpoint caps may be lower, never higher).
  - Response: `{"items": [...], "nextCursor": "..." | null}`. Cursor is opaque (base64 of keyset position, signed if it embeds filters); clients never parse it.
- Filtering: flat query params matching contract-declared filter schemas. Ranges as `from`/`to` pairs (`createdFrom`, `createdTo`, RFC3339). Multi-value as repeated params (`?status=OPEN&status=SETTLING`). Unknown filter params → `422 VALIDATION_FAILED` (silent ignoring hides client bugs).
- Sorting: `?sort=field` / `?sort=-field` from a per-endpoint allowlist. Default sort is always defined and stable (ties broken by id).
- No PII in query strings (principle 9): search-by-email etc. are `POST` with body (admin surface only, read-audited).

## 4. Error envelope

Every non-2xx from the origin — including guard, rate-limiter, maintenance, and framework-generated responses — is:

```jsonc
{
  "error": {
    "code": "WALLET_INSUFFICIENT_FUNDS",   // stable, from packages/contracts registry
    "message": "Balance too low for this buy-in.", // developer-facing English; client renders own copy by code
    "details": {                            // optional, schema per code
      "required": {"amount": 500, "currency": "TST"},
      "fields": [{"path": "stake.amount", "issue": "below_minimum"}] // validation errors
    },
    "traceId": "0198f3e2-…"                // correlates to logs/traces (§8)
  }
}
```

- `code` is the machine contract; `message` is never shown raw to players and never contains PII.
- Error-code **namespaces**: `AUTH_xxx`, `SESSION_xxx`, `DEVICE_xxx`, `USER_xxx`, `KYC_xxx`, `WALLET_xxx`, `PAYMENT_xxx`, `GAME_xxx`, `MATCH_xxx`, `LOBBY_xxx`, `RISK_xxx`, `RG_xxx`, `ADMIN_xxx` — plus cross-cutting singletons: `VALIDATION_FAILED`, `RATE_LIMITED`, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `MAINTENANCE`, `UPDATE_REQUIRED`, `GEO_BLOCKED`, `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `UNAUTHENTICATED`, `INTERNAL`. New codes are additive; codes are never repurposed. Registry lives in `packages/contracts` (single source, shared with Flutter error mapping, `../01-architecture/frontend-architecture.md` §7).

### Canonical HTTP status mapping

| Status | Meaning here | Typical codes |
|---|---|---|
| 400 | Malformed request (unparseable body, bad header syntax) | `VALIDATION_FAILED` |
| 401 | Missing/expired/invalid credentials; signature invalid | `UNAUTHENTICATED`, `AUTH_TOKEN_EXPIRED`, `AUTH_SIGNATURE_INVALID` |
| 403 | Authenticated but not allowed (role, ownership, KYC level, geo, RG block, frozen) | `FORBIDDEN`, `KYC_LEVEL_REQUIRED`, `GEO_BLOCKED`, `RG_SELF_EXCLUDED`, `RISK_FROZEN` |
| 404 | Resource absent or not yours (indistinguishable by design — no existence oracle) | `NOT_FOUND` |
| 409 | State conflict (version conflict, seat taken, replayed one-time token) | `CONFLICT`, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `AUTH_REFRESH_REUSED` |
| 422 | Well-formed but fails schema/domain validation | `VALIDATION_FAILED`, `WALLET_INSUFFICIENT_FUNDS`, `MATCH_NOT_JOINABLE` |
| 426 | **Forced update** — client below min version (rule 17). Body: `UPDATE_REQUIRED` + `details: {minVersion, updateUrl}`. Client hard-blocks to the update screen; no authenticated endpoint is reachable below min version. | `UPDATE_REQUIRED` |
| 429 | Rate limited (§7) | `RATE_LIMITED` |
| 500 | Unexpected server fault; no internals leaked, full detail in logs by `traceId` | `INTERNAL` |
| 503 | **Maintenance** (global or scoped kill-switch) or genuine overload. Body: `MAINTENANCE` + `details: {retryAfterSeconds, scope?}`; `Retry-After` header set. | `MAINTENANCE` |

No other statuses without a contracts change. Redirects (3xx) are not used by the API.

## 5. Idempotency-Key

- **Required on every state-changing endpoint** (`POST`/`PUT`/`PATCH`/`DELETE` that mutates domain state). Exempt only: pure-compute endpoints and safe re-issuable token mints (`/auth/ws-ticket`, `/token/refresh` — these have their own one-time semantics). Financial mutations (faucet, buy-in, adjustments, later deposits/withdrawals) additionally persist the key as the ledger `idempotency_key` (unique, forever — ADR-008).
- Format: header `Idempotency-Key: <UUIDv7>`, client-generated per logical operation (not per retry). Malformed/missing where required → `422 VALIDATION_FAILED`.
- Retention: **24 h** in the shared idempotency store (PG-backed via the shared interceptor, `../01-architecture/backend-architecture.md`); ledger-embedded keys never expire.
- Replay semantics:
  - Same key + **same request payload** (hash match) → return the **cached original response** (same status/body), no re-execution. In-flight original → second request waits or gets `409 CONFLICT` with retry guidance — never a concurrent double-execute.
  - Same key + **different payload** → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`. Never execute, never return the cached response (it belongs to a different request).
- The mobile retry queue (`../01-architecture/frontend-architecture.md` §8) relies on exactly these semantics.

## 6. Request signing (financial/sensitive endpoints)

Endpoints in the sensitive class (wallet mutations, withdrawal-shaped ops, device/session management, WS-ticket mint) require the device-bound detached signature. **Spec is owned by `../02-domains/authentication.md` §4** — summary of the header set:

| Header | Content |
|---|---|
| `X-Signature` | ES256 signature (Android Keystore device key) over `method\|path\|SHA256(body)\|timestamp\|nonce` |
| `X-Timestamp` | Unix ms; accepted within ±120 s of server time |
| `X-Nonce` | 128-bit random, single-use (Redis SETNX replay cache) |
| `X-Device-Id` | Registered device UUIDv7, must match the token's `did` |

Failure → `401 AUTH_SIGNATURE_INVALID` (clock-skew rejection returns server time in `details` for a one-shot client offset retry). Which endpoints are in the class is declared per-route in the OpenAPI spec (`x-requires-signature: true`) so client codegen attaches signing automatically.

## 7. Rate limiting headers

Redis token buckets per IP/user/device/endpoint-class (ADR-013). Every response on limited routes carries:

```
RateLimit-Limit: 10
RateLimit-Remaining: 4
RateLimit-Reset: 12          # seconds until refill
```

On `429`: `Retry-After: <seconds>` + `RATE_LIMITED` envelope. Clients honor `Retry-After` (the retry queue treats it as a floor). Limits themselves are config, not contract — clients must not hardcode them.

## 8. Correlation & tracing

- Server generates `traceId` (W3C trace-context internally) for every request; returned as response header `X-Trace-Id` and inside every error envelope. Support flows quote it; logs/Sentry key on it (OQ-10).
- Clients MAY send `X-Client-Request-Id` (UUIDv7) for their own correlation; it is logged, never trusted, never a substitute for `Idempotency-Key`.
- Inbound `traceparent` from the client is ignored (untrusted); internal hop propagation uses standard OTel context.

## 9. Localization

- API copy is not localized: `error.message` is developer-facing English. The client owns all player-facing strings, keyed by error `code`/enum values, localized in-app.
- `Accept-Language` is accepted and recorded (session locale for notifications/email templates, `../02-domains/*`), but never changes API response shapes. Server-rendered surfaces (download page, email) localize independently.

## 10. Versioning & deprecation

- `/v1` semantics are frozen: evolution is additive only (principles 4–5; rule 23). New required field, removed field, retyped field, or changed semantics ⇒ `/v2` of the affected surface + coexistence plan.
- Deprecating an endpoint/field within `/v1`: mark `deprecated` in OpenAPI, emit `Deprecation: true` and `Sunset: <RFC3339>` headers on responses, announce in release notes, keep serving until the **min-version floor** has passed the last client release that uses it (sideload lag: assume weeks, measure via version telemetry from the update endpoint, ADR-017).
- Enforcement order: additive change → deprecation window → min-version bump (forced update, §4/426) → removal. The 426 path is the backstop and must always work (rule 17); it is exercised in P13 e2e tests.
- Admin API (`/admin/v1`) versions independently; its only client is `apps/admin`, deployed in lockstep, so its deprecation windows may be short — but the envelope/conventions here still apply.
