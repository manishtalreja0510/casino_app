# Database Architecture

PostgreSQL 16+ is the **sole source of truth** for everything persistent and financial (ADR-004). Redis is disposable (ADR-005). This doc defines schema conventions, the ledger design (ADR-008), locking discipline, append-only mechanisms, migrations, and scaling. SQL below is **illustrative planning sketch**, not a migration; real DDL lands via the SQL-first migration flow (§8) starting P1/P4.

## 1. Ground rules (from `docs/00-project/system-rules.md`)

- Money = `BIGINT` minor units + currency code. No floats/decimals, anywhere (rule 4). Launch currency: `TST`.
- IDs = UUIDv7 (time-ordered → index-friendly), generated app-side or via extension. Time = `timestamptz`, UTC only.
- Ledger is double-entry, append-only; corrections are reversals (rule 5). Every financial mutation atomic + idempotent (rule 6).
- What **never** goes in PG: ephemeral WS/connection state, live matchmaking queues, rate-limit counters, replay ring buffers — that's Redis. What **never** goes in Redis: money, or anything whose loss loses truth (rule 7).

## 2. Schema-per-module ownership

Each NestJS module owns one PG schema; a module touches only its own schema (rule 20). Cross-module reads go through the owning module's exported services (`backend-architecture.md §3`).

| Schema | Owner module | Representative tables |
|---|---|---|
| `auth` | auth | `credentials`, `refresh_token_families`, `device_keys`, `ws_tickets` |
| `users` | users | `users`, `account_states` |
| `kyc` | kyc | `verifications`, `kyc_levels` |
| `wallet` | wallet | `accounts`, `ledger_transactions`, `ledger_entries`, `balances` |
| `payments` | payments | `deposits`, `withdrawals`, `psp_events` |
| `engine` | game-engine | `matches`, `game_events`, `game_snapshots`, `rng_draws` |
| `game_sessions` | game-sessions | `participants` |
| `matchmaking` | matchmaking | `match_formations` (audit trail) |
| `risk` | risk | `signals`, `scores`, `review_cases` |
| `rg` | responsible-gaming | `limits`, `exclusions` |
| `notif` | notifications | `templates`, `inbox`, `prefs` |
| `audit` | audit | `audit_log` |
| `admin` | admin | `admin_users`, `admin_roles`, `admin_audit` |
| `platform` | platform | `feature_flags`, `min_versions`, `jurisdiction_config` |
| `sessions` | auth/users (shared surface via auth services) | `sessions`, `devices` |

Naming: `snake_case`, singular schema, plural tables; `<thing>_id` FKs; `created_at`/`updated_at` `timestamptz NOT NULL DEFAULT now()` (no `updated_at` on append-only tables); no cross-schema FKs *except* the deliberate ones onto `users.users(id)` and ledger references, which are allowed because user identity is a platform-wide primitive.

Per-schema DB roles mirror ownership: the app connects with role(s) granted DML only on owned schemas — this makes rule 20 partially DB-enforced, and enables the ledger privilege revocations in §4.

## 3. The ledger (ADR-008) — `wallet` schema

Double-entry, append-only. Balances are a cached derivation, never the truth.

```sql
CREATE TABLE wallet.accounts (
  id          uuid PRIMARY KEY,                    -- UUIDv7
  type        text NOT NULL CHECK (type IN
              ('user_wallet','house_main','rake','bonus','match_escrow')),
  user_id     uuid NULL,                           -- set for user_wallet
  match_id    uuid NULL,                           -- set for match_escrow
  currency    char(3) NOT NULL,                    -- 'TST' at launch
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, currency),                      -- one wallet per user+currency
  UNIQUE (match_id, currency)                      -- one escrow per match+currency
);

CREATE TABLE wallet.ledger_transactions (
  id              uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,            -- THE idempotency anchor
  type            text NOT NULL,                   -- faucet_credit | match_buy_in |
                                                   -- match_settlement | reversal | ...
  ref_type        text NULL,  ref_id uuid NULL,    -- match id, deposit id, ...
  reverses_tx_id  uuid NULL REFERENCES wallet.ledger_transactions(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet.ledger_entries (
  id          uuid PRIMARY KEY,
  tx_id       uuid NOT NULL REFERENCES wallet.ledger_transactions(id),
  account_id  uuid NOT NULL REFERENCES wallet.accounts(id),
  amount      bigint NOT NULL CHECK (amount <> 0), -- signed minor units
  currency    char(3) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet.balances (                     -- cache, rebuildable from entries
  account_id  uuid PRIMARY KEY REFERENCES wallet.accounts(id),
  balance     bigint NOT NULL,
  version     bigint NOT NULL DEFAULT 0,           -- bumped every touch; drift canary
  updated_at  timestamptz NOT NULL,
  is_user     boolean NOT NULL,
  CHECK (NOT is_user OR balance >= 0)              -- user accounts never negative;
);                                                 -- house accounts may run negative
```

- **Idempotency:** every mutating financial op supplies an `idempotency_key` (deterministic where possible, e.g. `settle:{matchId}`); the unique index makes replays a detectable no-op inside the same transaction pattern.
- **Zero-sum enforcement:** entries per transaction must sum to 0 per currency. Strategy: a **constraint trigger, deferred to commit**, summing the transaction's entries — deferred because entries are inserted row-by-row within the tx and only the commit-time state must balance. No cross-currency entries in one transaction (multi-currency by design, OQ-08).

```sql
CREATE CONSTRAINT TRIGGER trg_tx_zero_sum
  AFTER INSERT ON wallet.ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet.assert_tx_balanced();
  -- assert_tx_balanced(): SELECT sum(amount) per (tx_id, currency); RAISE if <> 0
```

- **Append-only enforcement — two layers** (belt and braces, rule 5):
  1. **Privileges:** app roles get `INSERT`/`SELECT` only on `ledger_transactions`/`ledger_entries`; `UPDATE`/`DELETE`/`TRUNCATE` revoked for every non-superuser role.
  2. **Trigger guard:** `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION` — catches misconfigured roles and future migrations that would otherwise silently widen grants.
- **Corrections = reversal transactions only** (`type='reversal'`, `reverses_tx_id` set, entries negated). Nothing is ever edited; audit reads the pair.
- **Balance update discipline:** same DB transaction as the entries — `SELECT ... FOR UPDATE` on the touched `balances` rows in **globally consistent order** (ascending `account_id`), then insert entries, then update cached balances + `version`. The `CHECK` rejects overdrafts at the DB even if service logic is buggy.
- **Match flow invariant:** buy-ins move user→`match_escrow`; settlement moves escrow→winners + rake→house in one transaction, idempotent by match id; escrow balance is exactly 0 after settlement — reconciliation asserts it.
- Reconciliation jobs (rule 9): Σentries=0 globally, `balances` == derived sums, escrow accounts of settled matches == 0 and of open matches == Σbuy-ins, (P17+) PSP statement matching. Drift → page + freeze scope, never auto-fix.

## 4. Locking discipline

- Default isolation **READ COMMITTED** + explicit row locks. `SELECT ... FOR UPDATE` on all balance mutations; **ordered acquisition** (sort account ids) so concurrent settlements/transfers can't deadlock.
- **SERIALIZABLE** reserved for multi-account read-check-write flows where row locks can't cover the invariant (some reconciliation-critical checks, cross-account consistency verification); retry-on-serialization-failure wrapper mandatory there.
- Advisory locks (`pg_advisory_xact_lock`) for coarse single-flight sections (e.g. "one settlement runner per match") where row granularity doesn't fit; keyed by hashed UUID.
- Redis Redlock-style locks are latency optimizations only; anything correctness-bearing is fenced by PG (version columns / unique keys) per the brief.
- Lock hold time is minimized: no external I/O (PSP calls, HTTP) inside a transaction holding money locks — orchestration state machines (`payments`) exist precisely to split those.

## 5. Game event log — `engine` schema

Append-only `game_events` + periodic `game_snapshots` are the **truth** for match state; Redis hot state is a cache (ADR-006). Crash recovery = latest snapshot + replay.

```sql
CREATE TABLE engine.game_events (
  id         uuid PRIMARY KEY,
  match_id   uuid NOT NULL,
  seq        bigint NOT NULL,                      -- per-match, gapless
  type       text NOT NULL,
  payload    jsonb NOT NULL,                       -- full state-transition payload
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, seq)
);
CREATE TABLE engine.game_snapshots (
  match_id   uuid NOT NULL,
  seq        bigint NOT NULL,                      -- snapshot as-of event seq
  state      jsonb NOT NULL,                       -- FULL server state (incl. hidden info)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);
```

Same append-only enforcement pattern as the ledger (revoked UPDATE/DELETE + trigger guard). `payload`/`state` are the **server** view — hidden information included — so this data is as sensitive as the ledger; `playerView` filtering happens strictly at serialization time in the engine, never by trusting stored data shape. `engine.rng_draws` audit-logs every CSPRNG draw (match_id, purpose, value-commitment or value per game policy, seq) for dispute/certification evidence (ADR-016).

## 6. Audit log — `audit` schema

```sql
CREATE TABLE audit.audit_log (
  id          uuid PRIMARY KEY,
  seq         bigint GENERATED ALWAYS AS IDENTITY, -- global chain order
  actor_type  text NOT NULL,                       -- user | admin | system
  actor_id    uuid NULL,
  action      text NOT NULL,                       -- e.g. wallet.reversal, flags.change
  subject_ref text NULL,
  payload     jsonb NOT NULL,                      -- opaque IDs only; no PII (rule 15)
  prev_hash   bytea NOT NULL,
  hash        bytea NOT NULL,                      -- H(prev_hash || canonical(row))
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Append-only (same two-layer enforcement). Hash-chaining makes retroactive tampering evident: a periodic job re-verifies a random window + the head, and the head hash is exported to external storage (write-once bucket) so even a DB-admin-level attacker can't rewrite history silently. Every money/auth/admin/game-void/flag action writes here (rule 15); admin reads of sensitive data are audited too (P12).

## 7. Sessions & devices sketch — `sessions` schema

```sql
CREATE TABLE sessions.devices (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  public_key    bytea NOT NULL,        -- Android Keystore-backed device key (ADR-013)
  attestation   jsonb NULL,            -- hardening/integrity signals at registration
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz NULL
);
CREATE TABLE sessions.sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  device_id     uuid NOT NULL REFERENCES sessions.devices(id),
  refresh_family uuid NOT NULL,        -- reuse-detection family (auth schema)
  ip            inet NOT NULL,
  geo           jsonb NULL,            -- IP-geo at creation (geo-fencing input, rule 13)
  risk_flags    jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL,
  revoked_at    timestamptz NULL
);
```

(Sketch; final DDL comes from P3 migrations.) PG is truth; Redis caches session lookups. Global and per-user revocation = set `revoked_at` + cache invalidation. Raw IPs are operationally necessary (risk, geo-fencing) but are treated as personal data for retention (§10).

## 8. Migration policy (SQL-first, ADR-020)

- `drizzle-kit` generates SQL; the **SQL file is hand-reviewed/edited and is the artifact of record**. Every migration PR: forward SQL + a documented rollback (a tested `down` script, or an explicit "roll forward only" note with justification — ledger/audit DDL is typically forward-only).
- **Zero-downtime rules** (old and new app versions overlap during deploy):
  1. *Additive first*: new columns nullable/defaulted, new tables, new indexes `CONCURRENTLY`.
  2. *Backfill* as batched jobs, never in the migration transaction.
  3. *Constrain last*: `NOT NULL`/`CHECK`/FK added `NOT VALID` then `VALIDATE`, only after all writers are on the new version.
  4. Destructive changes (drop/rename) at least one release after the last reader is gone; renames via add-copy-swap.
- Migrations run as a deploy step with a lock; app boot verifies schema version and fails fast on mismatch.
- Ledger/audit/game-event DDL changes additionally require review sign-off against the invariant list in §3/§5/§6 (append-only guards must survive every migration) and constraint tests in CI.

## 9. Indexes, partitioning, pooling, replicas

**Indexes (representative):** `ledger_entries(account_id, created_at)`, `ledger_entries(tx_id)`, `ledger_transactions(idempotency_key)` (unique), `ledger_transactions(ref_type, ref_id)`, `game_events(match_id, seq)` (unique), `audit_log(actor_id, created_at)`, `sessions(user_id, revoked_at)`, partial indexes for open matches / active sessions. UUIDv7 keeps PK inserts append-mostly.

**Partitioning:** `ledger_entries`, `game_events`, `audit_log` are the high-churn, append-only tables — designed to accept **time/range partitioning** (monthly) *when volume demands* (trigger: table > ~100 GB or maintenance windows hurting). Not partitioned at launch (premature ops cost); the schemas avoid features that would block it (PKs include or can include the partition key path; no cross-partition uniqueness needs beyond what stated indexes cover — `idempotency_key` stays on the unpartitioned `ledger_transactions`).

**Connection pooling:** app-side pool per role; once instance count × pool size approaches PG limits, add **pgbouncer** in transaction-pooling mode — noted now because transaction pooling forbids session-level state (no session-scoped advisory locks, prepared-statement care); code style already complies (transaction-scoped locks only, §4).

**Read replicas:** one streaming replica from the start (also DR, §10 of `infrastructure-architecture.md`).
- **May read stale (replica-ok):** transaction-history pages, lobby/browse data, admin dashboards, analytics-ish queries, notification inbox.
- **Must not (primary-only):** anything inside a money transaction, balance reads that gate an action, idempotency checks, session/auth verification on financial endpoints, engine recovery reads, reconciliation (must see a consistent recent state; runs on primary or on a replica with lag guard + re-verify on primary before paging).

## 10. Retention (OQ-01-dependent)

Defaults until the jurisdiction fixes real numbers (P15, `docs/06-compliance/*`): ledger + audit_log — indefinite (financial record); game_events/snapshots — full fidelity ≥ dispute window (default 90 days) then archived to cold storage, not deleted, pending license terms; sessions/IP data — minimized after 12 months; KYC PII — provider-side storage preferred, minimal local retention (P16). Every table gets a retention class label in its owning domain doc; the jurisdiction matrix overrides defaults. Deletion requests (data-protection law) never touch ledger/audit — lawful basis is financial/AML record-keeping; personal data elsewhere is erased/pseudonymized per policy.

## 11. Explicit non-goals

No PG for: live WS rooms/presence, matchmaking queues, rate limiting, hot per-tick game state (Redis, rebuilt from PG on loss). No Redis for: balances, ledger, match results, KYC/payment state, flags truth, anything reconciliation depends on. No event-sourcing outside the game event log; no CQRS framework; no sharding before the partitioning + replica levers are exhausted (`system-architecture.md §9`).
