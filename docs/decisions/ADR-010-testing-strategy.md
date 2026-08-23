# ADR-010: Testing strategy

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

Bugs here are not UI glitches — a concurrency bug in settlement is lost money; a `playerView` leak is cheating-as-a-service. Failing tests fail the phase (rule 18). The strategy must give proportionally brutal coverage to money and game-correctness paths without drowning the rest of the codebase in ceremony.

## Decision

The **pyramid + specialized suites** of [testing-strategy.md](../05-testing/testing-strategy.md):

| Layer | Tooling | Focus |
|---|---|---|
| Unit | Jest (backend), flutter_test | reducers, pure logic, providers |
| Integration | **Testcontainers (real PG + Redis)** + supertest | API + DB behavior, constraints, migrations |
| E2E | integration_test (Flutter), Socket.IO harness | full flows on staging-like stack |
| Golden | flutter_test goldens | `ui_kit` components/tokens |

Non-negotiable specializations:

- **Money paths run against real PostgreSQL** (Testcontainers, never mocks/SQLite): row locks, isolation levels, constraint triggers, and append-only guards ARE the logic under test. Includes concurrency tests (parallel debits can't overdraw; idempotent replays no-op; crash mid-transaction leaves ledger consistent) and constraint tests (UPDATE/DELETE on ledger rejected; unbalanced transactions rejected).
- **Property-based tests** on financial and game math: ledger conservation under random op sequences, settlement zero-sum with rake, poker hand-evaluation, RNG-distribution sanity.
- **Adversarial protocol suite**: a custom Node Socket.IO harness sending out-of-turn/malformed/replayed/other-player actions, forged seq/resume, expired tickets — asserting rejection + risk signals, per the [threat model](../04-security/threat-model.md).
- **Conformance suite** (ADR-009): every `GameDefinition` passes engine-level invariants (determinism, illegal-action rejection, `playerView` information-hiding, settlement math) before registration.
- **Load harness**: harness from P5 grows into k6 + Socket.IO load tests; **P14 load/chaos results gate any real-money phase** — including Redis-loss recovery drills (ADR-005).

## Alternatives considered

- **Mock-heavy unit-only testing.** Fast CI, but mocks by construction cannot catch the bugs that matter most here — lock ordering, isolation anomalies, constraint behavior, idempotency races all live in the PG interaction being mocked away. Green suites, broken money. Rejected for anything touching PG/Redis semantics; mocks stay legitimate at unit level for ports (PSP/KYC fakes) and pure logic.
- **Manual QA reliance.** Humans cannot reproduce 1k-concurrent-settlement races or replay attacks, and regression cost grows per game. Manual testing remains only exploratory UX passes and release smoke checks — never the correctness net. Rejected.

## Consequences

**Positive:** the bug classes that lose money or leak cards have dedicated nets; real-PG testing catches migration/constraint regressions in CI; conformance makes game #3..10 cheap to trust; adversarial suite turns the threat model into executable regression checks.

**Negative (accepted):** Testcontainers CI is slower and needs Docker-capable runners (mitigated by Turbo caching + path filters, ADR-001); property and adversarial tests are skilled, ongoing investment and can flake without seed discipline (failures must record seeds); load infrastructure costs money and maintenance before it "pays off"; the suite's rigor is itself a velocity tax on money-path changes — accepted deliberately (rule 30).

## Links

- [testing-strategy.md](../05-testing/testing-strategy.md), [unit-testing.md](../05-testing/unit-testing.md), [threat-model.md](../04-security/threat-model.md)
- [system-rules.md](../00-project/system-rules.md) rules 18, 30; ADR-008 (ledger invariants), ADR-009 (conformance)
- Phases: P4 (money tests), P5 (harness seed), P6 (conformance), P14 (load/chaos gate)
