# Architecture Decision Records

ADRs record every major architectural decision: the problem, the choice, the alternatives, and the trade-offs we knowingly accepted. They exist so future contributors (human or AI) can distinguish "deliberate decision" from "accident of history" — and know what evidence would justify revisiting one.

## When an ADR is required

Per [system rule 19](../00-project/system-rules.md): **major architectural changes require an ADR before implementation.** That means anything that:

- adds/removes a technology, datastore, protocol, or third-party dependency category;
- changes a module boundary, data-ownership rule, or the game contract;
- touches money handling, security posture, or the trust model;
- supersedes or contradicts an existing ACCEPTED ADR or a system rule (rules marked ⛔ cannot be overridden by any ADR).

Small implementation choices inside an existing boundary do not need an ADR — document them in the relevant `docs/02-domains/*` doc instead.

## Process

1. Copy the template below into `ADR-0nn-kebab-case-title.md` with the next free number. Numbers are permanent; never renumber or reuse.
2. Status starts `PROPOSED`. It becomes `ACCEPTED` when the decision is made (and any blocking OQ-nn is resolved), or `SUPERSEDED by ADR-0mm` if replaced. Superseded ADRs are never deleted or edited beyond the status line.
3. Add/update the row in the index table here, in the same PR.
4. If the ADR depends on an open question, name the OQ-nn in the Status line and in `docs/00-project/open-questions.md`.

## Template

```markdown
# ADR-0nn: Title

**Status:** PROPOSED | ACCEPTED | SUPERSEDED by ADR-0mm  (blocked on OQ-nn where relevant)
**Date:** YYYY-MM-DD

## Context
The problem and the forces on it. Dense; no filler.

## Decision
The concrete choice, stated so an implementer can act on it.

## Alternatives considered
Each alternative + why rejected (one paragraph max each).

## Consequences
Positive AND negative — including the pain we knowingly accept.

## Links
Relative paths to related docs, ADR-nnn, OQ-nn, phases P-nn.
```

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-001](ADR-001-monorepo-architecture.md) | Monorepo architecture (pnpm + Turborepo + melos, contract-first codegen) | ACCEPTED |
| [ADR-002](ADR-002-flutter-architecture-state-management.md) | Flutter architecture & state management (Riverpod v2, go_router) | ACCEPTED |
| [ADR-003](ADR-003-nestjs-modular-monolith.md) | NestJS modular monolith | ACCEPTED |
| [ADR-004](ADR-004-postgresql-source-of-truth.md) | PostgreSQL as sole source of truth | ACCEPTED |
| [ADR-005](ADR-005-redis-responsibilities-limits.md) | Redis responsibilities & limits | ACCEPTED |
| [ADR-006](ADR-006-server-authoritative-games.md) | Server-authoritative game architecture | ACCEPTED |
| [ADR-007](ADR-007-websocket-strategy.md) | WebSocket strategy (Socket.IO) | ACCEPTED |
| [ADR-008](ADR-008-double-entry-ledger.md) | Double-entry financial ledger | ACCEPTED |
| [ADR-009](ADR-009-modular-game-contract.md) | Modular game contract (`GameDefinition`) | ACCEPTED |
| [ADR-010](ADR-010-testing-strategy.md) | Testing strategy | ACCEPTED |
| ADR-011 | Secrets & config management + secret-manager/cloud comparison | PROPOSED (OQ-06) |
| ADR-012 | Environment & flavor strategy | ACCEPTED |
| ADR-013 | Network security (pinning + rotation, token model, request signing) | ACCEPTED |
| ADR-014 | Payment-provider abstraction | PROPOSED (OQ-02) |
| ADR-015 | KYC-provider abstraction | PROPOSED (OQ-03) |
| ADR-016 | RNG & fairness (certification lab pending) | PROPOSED (OQ-01) |
| ADR-017 | Off-store distribution & forced update | ACCEPTED |
| ADR-018 | Fraud/risk engine approach | ACCEPTED |
| ADR-019 | Placeholder-first UI & design-token migration | ACCEPTED |
| ADR-020 | Data access layer (Drizzle, SQL-first migrations) | ACCEPTED |

ADR-011 through ADR-020 are authored in a parallel documentation pass; titles and statuses above are canonical regardless of file arrival order.
