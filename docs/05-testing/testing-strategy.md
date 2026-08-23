# Testing Strategy (ADR-010)

How this platform is tested, why the shape differs from a generic web app, and which suites gate what. Companion docs: [unit-testing.md](./unit-testing.md), [integration-testing.md](./integration-testing.md), [e2e-testing.md](./e2e-testing.md), [performance-testing.md](./performance-testing.md). Tooling is fixed by ADR-010: Jest, Testcontainers (PG+Redis), supertest, flutter_test/integration_test, golden tests for `ui_kit`, k6 + a custom Node Socket.IO harness for load.

## 1. The pyramid, adapted

A real-money platform's failure modes are money drift, information leaks, and desync under concurrency — not broken buttons. The classic pyramid is reweighted accordingly:

| Layer | Weight | Content | Runs |
|---|---|---|---|
| Unit + property | Heaviest | Money math, ledger ops, game reducers, hand evaluation, settlement/rake, risk rules. Property-based (fast-check) wherever an invariant exists. | Every commit |
| Integration | Heavy | Real PG+Redis via Testcontainers; real migrations; supertest + real Socket.IO clients. Concurrency, idempotency, recovery, webhooks, resume protocol. | Every PR (critical set), full nightly |
| Adversarial / protocol | **First-class, product-specific** | Malicious-client simulation: requesting others' hole cards, out-of-turn actions, malformed/oversized payloads, replayed signed requests, seq manipulation, forged webhooks. The client is compromised by definition (system-rules 1–2), so hostile input is a *category*, not an afterthought. | Every PR for touched domains, full nightly |
| E2E (device) | Thin | A small catalog of critical journeys on emulator/device against staging. | Nightly + release |
| Load / chaos | Gate | k6 + Socket.IO harness; chaos drills. **Must pass before any real-money phase completes (P14 gate).** | P14, then per release into P18+ |

## 2. What must NEVER be mocked

| Never mocked | Where | Why |
|---|---|---|
| PostgreSQL | Any ledger/financial-path test above pure unit level | Row locks, isolation levels, constraint triggers, and zero-sum enforcement **are** the correctness mechanism (ADR-008); a mock proves nothing. Testcontainers PG with real migrations, always. |
| Redis | Resume protocol, matchmaking, lock tests | Adapter/lock semantics are the subject under test. |
| RNG audit path | Engine tests | `ctx.rng` may be *seeded* (deterministic sequence) but the draw-audit logging pipeline must be the real one — audit completeness is an ADR-016 requirement. |
| Ledger append-only guards | Constraint tests | UPDATE/DELETE rejection is verified against the real DB privileges + trigger, per P1/P4 acceptance. |
| Signature verification (webhooks, request signing, release manifests) | Integration | Fake *providers* are fine (§6); fake *crypto* is not. |

Legitimately faked: PSP and KYC providers (OQ-02/03 — see §6), external email/push transports, wall-clock time, RNG *sequences* (never the interface or audit path).

## 3. Determinism rules

Flaky tests in a money system erode the only signal that matters. Non-negotiable:

- **Seeded RNG injection.** All game/engine tests inject a seeded deterministic `RngService` through the same port as production CSPRNG. No test depends on real entropy; property tests log the failing seed for replay.
- **Fake clocks via the injected clock.** All time-dependent logic (timers, token TTL, grace periods, rate-limit windows) reads `ctx.clock` / the clock port. Tests advance a fake clock explicitly. Direct `Date.now()` in domain code is a review-blocker.
- **No sleeps.** Waiting is always on an observable condition (event received, job completed, row present) with a bounded poll/timeout — never `sleep(n)` as synchronization.
- **No shared mutable state between tests**; unique UUIDv7 fixtures per test; isolation strategy per [integration-testing.md §3](./integration-testing.md).
- **No wall-clock/timezone dependence** — everything timestamptz/UTC (brief), tests set TZ explicitly.

## 4. Coverage philosophy

Line % is a weak proxy; a ledger can be 100% line-covered and still overdraw under concurrency. Priorities:

1. **Invariant coverage first**: every documented invariant (entries sum to zero, escrow zeroes at settlement, balances non-negative, no hidden-info leak in `playerView`, seq monotonicity, idempotent replay = no-op) has at least one property test and one concurrent integration test.
2. **Line thresholds only where cheap signal is still worth having**: `wallet`, `game-engine`, and each game's reducer module carry an enforced line/branch threshold (set in P4/P6 phase plans, ratcheted never lowered). Other modules: no numeric gate; review judges adequacy.
3. **Mutation-testing spot checks** (optional, nightly) on wallet/settlement math where the cost is justified.

## 5. Test data management

- **Factories, not fixtures-by-hand**: per-domain factory functions (backend TS + Dart) producing valid entities with overridable fields; composed for scenarios (user-with-wallet, seated-table, mid-hand-state).
- **No production data, ever** — not sampled, not "anonymized". All PII in tests is synthetic (generated names/emails/documents clearly marked test-only). This also keeps us honest before OQ-01 data-residency answers exist.
- Seed scripts for staging are the same factories, run via a controlled job; staging data is resettable (see [e2e-testing.md §5](./e2e-testing.md)).
- Test currency `TST` throughout; no test ever references a real currency code.

## 6. Fake providers as permanent citizens

`FakePsp` and `FakeKyc` implement `PaymentProviderPort`/`KycProviderPort` fully (webhooks, signatures, failure verdicts, statement export) and live in the repo as first-class packages. They power all payment/KYC tests now and **staging until P15 closes**; when real adapters arrive (P16/P17), the fakes remain the fast lane and the contract oracle. Details: [integration-testing.md §7](./integration-testing.md).

## 7. Contract-conformance suite — the reuse centerpiece

One suite, written in P6, that any `GameDefinition` must pass (ADR-009): lifecycle legality, reducer purity/determinism under seeded RNG, `playerView` leak scan (serialize every view, assert no non-owner hidden fields), timeout handling, settlement instructions sum-correct and idempotent, snapshot+replay equivalence, terminal-state reachability. Every new game (P8, P9, future ~10) runs it unchanged — this is how "scale to ~10 games" stays testable at constant cost. See [integration-testing.md §6](./integration-testing.md).

## 8. Suites and gates per phase

| Suite | Blocks merge (PR) | Nightly | Phase gates |
|---|---|---|---|
| Lint / typecheck / analyze | ✔ all workspaces (path-filtered) | ✔ | every phase |
| Backend unit + property | ✔ | ✔ (higher fast-check run counts) | every backend phase |
| Backend integration (critical set: ledger, idempotency, auth) | ✔ | full matrix ✔ | P4+ |
| Adversarial/protocol | ✔ for touched domains | full ✔ | P5, P9, P14 |
| Contract conformance | ✔ when engine or any game touched | ✔ | P6+, each new game |
| Flutter unit + widget + golden | ✔ | ✔ | P2+ |
| Contract drift (OpenAPI ↔ generated Dart) | ✔ | ✔ | P2+ |
| Flutter integration_test (compose stack) | subset ✔ | full ✔ | P3+ |
| Device e2e (staging) | — | ✔ | release + P13/P14 acceptance |
| Load / soak / chaos | — | smoke weekly | **P14 gate; re-run in P18** |
| Security tests (see §11) | ✔ (static/scanning) | ✔ | every phase DoD |

Rule 18 applies: failing tests fail the phase; no completion claims over red or skipped suites.

## 9. Flaky-test policy

- A test that fails without a code cause is **quarantined, never deleted**: moved to a quarantine tag (excluded from merge gate, still run nightly) with a tracking issue created in the same commit, owner assigned.
- Quarantine has a budget (default 10 tests / 14 days each, set per phase plan); exceeding it blocks new feature merges for the owning module.
- A flaky test in ledger/engine/adversarial suites is treated as a **potential real race** first — investigated as a bug before being written off as test debt.
- Deleting any test in a gated suite requires stating the replacement coverage in the PR description.

## 10. CI orchestration (GitHub Actions)

- **Path-filtered, parallel per workspace** (pnpm/Turborepo on TS, melos on Dart): `apps/api`, `apps/mobile` (+ its packages), `packages/contracts`, `apps/admin` (P12+) each get their own job graph; contracts changes fan out to both sides.
- Turborepo remote caching for unchanged tasks; Testcontainers jobs pull pinned PG 16 / Redis 7 images.
- Merge gate = §8 "blocks merge" column; nightly workflow runs the full matrix + long property runs + integration full set; weekly load smoke.
- Secret scanning (gitleaks), dependency audit, and APK string-dump spot check run in CI per P0/P2 scope.

## 11. Security tests are part of Definition of Done

Every phase's DoD includes the security checklist run (`docs/04-security/security-checklist.md`) **and** automated security tests where they exist: token-reuse/family-revocation tests, request-signing tamper/replay tests (P3), webhook forgery tests, `playerView` leak scans, log-scrubbing tests (no PII/token fields serialized), audit-log immutability constraint tests, forced-update enforcement tests (P13). Adversarial suite results feed the P14 pen-test scope. A checklist item without a corresponding automated test where one is feasible is a gap to record, not to wave through.
