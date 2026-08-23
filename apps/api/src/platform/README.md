# Platform chassis + module template

Everything in `src/platform/` is the chassis a domain module may assume exists. Domain
modules (`auth`, `users`, `wallet`, `game-engine`, `games/*`, …) are added from P3 onward.

## What the chassis provides

| Provider | Import token | Purpose |
|---|---|---|
| PostgreSQL pool | `PG_POOL` | Raw SQL, explicit locking (required for ledger paths — ADR-020) |
| Drizzle | `DRIZZLE` | Typed queries for ordinary CRUD |
| `withTransaction(pool, fn)` | — | One transaction for an operation **and** its audit entry |
| Redis | `REDIS` | Cache, locks, queues, rate limiting — never financial truth (rule 7) |
| `FlagsService` | injected | Feature flags and kill-switches; fails closed (rule 16) |
| `AuditService` | injected | Append to the immutable audit log (rule 15) |
| `AuditChainService` | injected | Verify chain integrity / read the head hash |
| `JobsService` | injected | BullMQ queues and workers; every job must be idempotent |
| `RateLimiter` | injected | Redis fixed-window limiter, per endpoint class |
| Structured logging | Nest logger | pino with redaction; never log PII or secrets (rule 15) |

## Adding a domain module

```
src/<domain>/
  <domain>.module.ts        wiring; exports ONLY the service surface other modules may use
  <domain>.controller.ts    HTTP surface; validates input, no business logic
  <domain>.service.ts       business logic; throws typed DomainErrors
  <domain>.repository.ts    the ONLY place this module's tables are touched
  dto/                      request/response types derived from @casino/contracts
  <domain>.spec.ts          unit tests
```

Rules that are not negotiable (`docs/00-project/system-rules.md`, `docs/01-architecture/backend-architecture.md` §3):

1. **Own tables only.** A module reads and writes only tables in its own schema. Need
   another module's data? Call its exported service. Importing another module's
   repository is a review-blocking violation.
2. **Errors are typed.** Throw a `DomainError` subclass with a contract `ErrorCode`.
   Never let a driver error reach the client — the filter turns unknown errors into
   `INTERNAL` precisely so nothing leaks (rule 15).
3. **Money is integer minor units, through the ledger, always** (rules 4–6, 10).
   `games/*` never import `wallet`.
4. **Audit sensitive actions in the caller's transaction**:
   ```ts
   await withTransaction(pool, async (client) => {
     await this.repository.doTheThing(client, input);
     await this.audit.append({ actorType: 'user', actorId, action: 'domain.thing' }, client);
   });
   ```
   Passing `client` is what makes the audit entry roll back with the action it records.
5. **Check the gate before any real-money path**: `await flags.isRealMoneyEnabled()`
   — and remember it is OFF by default and fails closed (rule 11).
6. **Jobs are idempotent.** Re-read the state machine from PostgreSQL and no-op if the
   transition already happened; never carry state in the job payload alone (rule 7).

## What the chassis deliberately does not do

Authentication and authorisation (P3), request validation pipes bound to contract schemas
(P3, when the first request bodies exist), WebSocket transport (P5), and OpenTelemetry
exporters (collector choice is OQ-10). Health checks cover PostgreSQL and Redis only —
add a probe when you add a dependency, never a probe for something you have not verified.
