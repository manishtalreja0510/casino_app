# Progress

Living status of every phase. Allowed statuses: `NOT_STARTED · RESEARCH · PLANNING · PLAN_REVIEW · READY_FOR_IMPLEMENTATION · IMPLEMENTING · TESTING · SECURITY_REVIEW · DOCUMENTATION · COMPLETE · BLOCKED`.
Update this file in the same PR as any status change. BLOCKED entries must name the blocker (P-nn / OQ-nn / external).

**Planning session (2026-08-23):** documentation foundation created — architecture, domains, security, compliance, operations, design-system docs, ADR-001…020, roadmap P0–P20. No application code exists yet.

| Phase | Name | Status | Blocker / notes |
|---|---|---|---|
| P0 | Foundations | NOT_STARTED | Recommended starting point |
| P1 | Backend platform core | NOT_STARTED | needs P0 |
| P2 | Flutter platform core | NOT_STARTED | needs P0 |
| P3 | Auth & identity | NOT_STARTED | needs P1, P2 |
| P4 | Wallet & ledger (test currency) | NOT_STARTED | needs P3 |
| P5 | Real-time core | NOT_STARTED | needs P3 |
| P6 | Game engine & contract | NOT_STARTED | needs P4, P5 |
| P7 | Matchmaking & lobby | NOT_STARTED | needs P6 |
| P8 | Casino game #1 (test currency) | NOT_STARTED | needs P7; game choice = OQ-05 (rec: Crash) |
| P9 | Poker (test currency) | NOT_STARTED | needs P7; variant = OQ-07 (rec: NLHE cash) |
| P10 | Risk & responsible gaming v1 | NOT_STARTED | needs P8 or P9 |
| P11 | Notifications | NOT_STARTED | needs P5; transport = OQ-09 |
| P12 | Admin panel v1 | NOT_STARTED | needs P4 (risk queues need P10) |
| P13 | Distribution & updates | NOT_STARTED | needs P2 (+P1 for enforcement) |
| P14 | Hardening & load | NOT_STARTED | needs P8–P13; gates P18 |
| P15 | Compliance gate closure | BLOCKED | OQ-01, OQ-02, OQ-03, OQ-11 — business/legal track, start now |
| P16 | KYC integration | BLOCKED | P15 |
| P17 | Payments (PSP) | BLOCKED | P15, P16 |
| P18 | Real-money enablement & launch | BLOCKED | P14–P17 |
| P19 | Design integration | BLOCKED | UI-designer onboarding; needs P2 baseline |
| P20 | iOS | BLOCKED | OQ-04 (unscheduled) |

## Open-question status snapshot
See `docs/00-project/open-questions.md` for detail. Launch-critical: OQ-01 (jurisdiction/license) → OQ-02 (PSP) → OQ-03 (KYC). Needing owner confirmation of a made recommendation: OQ-06 (cloud + secret manager).
