# Integration Testing

Real infrastructure, real migrations, real protocols. This layer proves the properties that mocks cannot: locking, isolation, idempotency, recovery, and ordering under concurrency. Strategy context: [testing-strategy.md](./testing-strategy.md) §1–§3.

## 1. Backend harness

- **Testcontainers PG 16 + Redis 7 per suite** (pinned image digests, same versions as prod). One container pair per Jest project/worker, reused across tests within a suite for speed; never shared across workers.
- **Real migrations run** against the container before the suite — the SQL-first Drizzle migrations from the repo (ADR-020), including privilege revocations and append-only triggers. Schema is never hand-created in tests; if migrations don't produce it, the test must fail.
- **HTTP via supertest** against a booted Nest application (real module wiring, fake external ports only).
- **Gateway tests via a real Socket.IO client** (`socket.io-client`) through the real handshake: REST → WS ticket → connect → rooms. No in-process gateway shortcuts for protocol-level assertions.
- Injected clock/RNG/ID ports as in unit tests ([unit-testing.md §1](./unit-testing.md)); waiting is condition-based, never sleeps.

## 2. What is never mocked here

PG, Redis, migrations, signature verification, the RNG audit path ([testing-strategy.md §2](./testing-strategy.md)). External providers are faked per §7 — but through their real ports, over real HTTP webhooks with real signature verification against fake-provider keys.

## 3. Isolation between tests

- **Default: transactional truncation** — after each test, truncate module-owned tables (ordered, FK-aware helper) + `FLUSHDB` on the test Redis logical DB. Cheap and deterministic.
- **Not** per-test wrapping transactions with rollback for financial paths: the ledger's correctness depends on real commits, real row locks, and multi-connection interleavings; a single wrapped transaction would mask exactly the bugs we hunt. Concurrency tests always use multiple real connections/pool clients.
- Suites needing cross-test continuity (state-machine progressions) manage their own scoped data via unique UUIDv7 roots instead of truncation.
- Append-only tables can't be truncated in prod-shaped roles; test harness uses a superuser maintenance connection for cleanup only — never inside test logic.

## 4. Critical integration suites (the canon)

Each maps to phase acceptance criteria in `docs/MASTER_ROADMAP.md`; all are merge-gating once their phase lands.

| Suite | Proves | Sketch |
|---|---|---|
| **Ledger concurrency** (P4) | No overdraw, no drift under parallel load | N parallel connections race debits/settlements against shared accounts; assert: no negative user balance ever committed, entries sum to zero per transaction, final derived balance == cached balance, total money conserved across the run |
| **Idempotency replay** (P4) | Replays are no-ops | Same idempotency key submitted concurrently and sequentially, incl. after simulated crash-before-response; exactly one ledger transaction exists; response replay returns original result |
| **Webhook idempotency + signature** (P17-shaped, built against fakes now) | Rule 8 | Fake PSP/KYC ([§7](#7-fake-providers)) delivers: duplicate event ids (one state change), tampered payloads/bad signatures (rejected, audited, no state change), out-of-order events (state machine holds) |
| **Engine recovery** (P6) | Crash ≠ money loss | Kill/restart the engine process (and drop Redis hot state) mid-match; assert resume from `game_snapshots`+`game_events` replay produces identical state, or the void+refund path returns stacks with ledger intact and audit entries present. Run against coin-duel; re-run per game via conformance suite |
| **Matchmaking races** (P7) | No double-seat, no lost buy-in | N clients race M seats (N≫M): each seat filled once, exactly M buy-ins escrowed, losers' funds untouched, reservation TTL expiry releases seats |
| **Resume protocol** (P5) | Seq gaps handled | Real Socket.IO client disconnects; server emits during gap; on resume with `lastSeq`: gap within ring-buffer window ⇒ exact replay, no duplicates/reordering (client-side assertion); gap beyond window ⇒ full `playerView` resync; forged/stale seq ⇒ resync, never leak |
| **Reconciliation catches drift** (P4) | Rule 9 | Inject drift via maintenance connection (unbalanced fixture, wrong cached balance, orphan escrow); reconciliation job flags each, fires alert hook, freezes affected scope; never auto-corrects |
| **Audit chain integrity** (P1) | Rule 15 | Chain verifies end-to-end; tampering any row breaks verification from that point; UPDATE/DELETE rejected by the real trigger/privileges |

Adversarial/protocol suite (hole-card requests, out-of-turn/malformed actions, oversized payloads, replayed signed requests) also lives at this layer — real gateway, hostile client scripts.

## 5. Flutter integration_test

Runs the real app (dev flavor) against a **local backend compose stack** (api + PG + Redis + fake providers — same compose file developers use). Covers: signup→login→session persistence, wallet history rendering from real API, WS connect/reconnect banner behavior, a scripted coin-duel round. Subset gates merge; full set nightly ([testing-strategy.md §8](./testing-strategy.md)). Device-matrix e2e against staging is the next layer up ([e2e-testing.md](./e2e-testing.md)).

## 6. Contract-conformance suite (games)

The reuse centerpiece (ADR-009, [testing-strategy.md §7](./testing-strategy.md)). Parameterized over any registered `GameDefinition`, run at this layer with real engine + PG persistence:

- lifecycle legality (created→…→settled|voided only via engine);
- deterministic replay: same seed + same action log ⇒ identical terminal state and events;
- `playerView` leak scan on every emitted state (no non-owner hidden fields serialized — protocol-level, not code review);
- `onTimeout` on every timer id in every reachable phase;
- settlement instructions conserve escrow exactly; double-settle attempt is a no-op;
- snapshot at arbitrary event index + replay ⇒ state equivalence;
- kill-mid-match recovery per §4.

A game that passes gets platform trust; a game that needs suite changes triggers a contract-versioning conversation, not a suite fork.

## 7. Contract tests (API schema drift)

`packages/contracts` is the single source; the Dart `api_client` is generated. CI regenerates from the current OpenAPI + WS event schemas and fails on diff vs committed generated code (**schema drift fails CI**). Additionally: recorded round-trip tests deserialize real API responses (from the compose stack) into generated Dart models — catching semantic drift the generator can't (nullable-in-practice fields, enum growth). Breaking-change lint on the OpenAPI diff enforces rule 23 (additive within `/v1`).

## 8. Fake providers

`FakePsp` and `FakeKyc` are **permanent test citizens**, not throwaway stubs — full implementations of `PaymentProviderPort` / `KycProviderPort` (ADR-014/015):

- Real HTTP webhook delivery with signatures (own test keypairs), configurable latency/retry/duplicate/out-of-order behavior, scriptable verdicts (approve/reject/review, deposit success/fail/chargeback), statement export for reconciliation tests.
- They power local compose, CI integration suites, **and staging until P15** decides real providers — so every payment/KYC flow, screen, and state machine is exercised for real long before OQ-02/OQ-03 close.
- When real adapters land (P16/P17), the same port-level test suites run against provider sandboxes; the fakes remain the fast deterministic lane and the behavioral spec of what the platform assumes about any provider.
