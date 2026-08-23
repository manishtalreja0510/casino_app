# Progress

Living status of every phase. Allowed statuses: `NOT_STARTED · RESEARCH · PLANNING · PLAN_REVIEW · READY_FOR_IMPLEMENTATION · IMPLEMENTING · TESTING · SECURITY_REVIEW · DOCUMENTATION · COMPLETE · BLOCKED`.
Update this file in the same PR as any status change. BLOCKED entries must name the blocker (P-nn / OQ-nn / external).

**Planning session (2026-08-23):** documentation foundation created — architecture, domains, security, compliance, operations, design-system docs, ADR-001…022, roadmap P0–P20.

**Owner decisions (2026-08-23)** — see `MASTER_ROADMAP.md` §"Owner decisions applied" and `00-project/open-questions.md`: licensing delegated to a separate team (P15 becomes a hand-off checkpoint, not an engineering gate); payments are direct-credit for now (ADR-022, lands in P4; P17 parked); KYC verification skipped for now (P16 parked, all accounts at L0); distribution channel owned by a separate team (P13 narrowed to server-side min-version enforcement); AWS confirmed as target with a **local-first, zero-cost development mandate** (ADR-021).

| Phase | Name | Status | Blocker / notes |
|---|---|---|---|
| P0 | Foundations | COMPLETE | 2026-08-23 · `phases/PHASE-00-foundations.md` |
| P1 | Backend platform core | NOT_STARTED | P0 complete — ready to plan |
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
| P13 | Distribution & updates (narrowed) | NOT_STARTED | server-side min-version enforcement only; channel owned by separate team |
| P14 | Hardening & load | NOT_STARTED | needs P8–P13; gates P18 |
| P15 | Compliance hand-off checkpoint | BLOCKED | external licensing team owns it; not an engineering gate |
| P16 | KYC integration | BLOCKED | PARKED by owner decision — verification skipped for now |
| P17 | Payments (real PSP) | BLOCKED | PARKED — direct-credit interim lands in P4 (ADR-022) |
| P18 | Real-money enablement & launch | BLOCKED | P14–P17 |
| P19 | Design integration | BLOCKED | UI-designer onboarding; needs P2 baseline |
| P20 | iOS | BLOCKED | OQ-04 (unscheduled) |

## Open-question status snapshot
See `docs/00-project/open-questions.md` for detail. **Decided/handled:** OQ-01 (delegated), OQ-02 (deferred; direct-credit interim), OQ-03 (deferred; L0 only), OQ-06 (AWS confirmed + local-first mandate). **Still open, none blocking current work:** OQ-04 (iOS), OQ-05 (casino game — needed by P8), OQ-07 (poker variant — needed by P9), OQ-08..OQ-14.
