# Progress

Living status of every phase. Allowed statuses: `NOT_STARTED · RESEARCH · PLANNING · PLAN_REVIEW · READY_FOR_IMPLEMENTATION · IMPLEMENTING · TESTING · SECURITY_REVIEW · DOCUMENTATION · COMPLETE · BLOCKED`.
Update this file in the same PR as any status change. BLOCKED entries must name the blocker (P-nn / OQ-nn / external).

**Planning session (2026-08-23):** documentation foundation created — architecture, domains, security, compliance, operations, design-system docs, ADR-001…022, roadmap P0–P20.

**Owner decisions (2026-08-23)** — see `MASTER_ROADMAP.md` §"Owner decisions applied" and `00-project/open-questions.md`: licensing delegated to a separate team (P15 becomes a hand-off checkpoint, not an engineering gate); payments are direct-credit for now (ADR-022, lands in P4; P17 parked); KYC verification skipped for now (P16 parked, all accounts at L0); distribution channel owned by a separate team (P13 narrowed to server-side min-version enforcement); AWS confirmed as target with a **local-first, zero-cost development mandate** (ADR-021).

| Phase | Name | Status | Blocker / notes |
|---|---|---|---|
| P0 | Foundations | COMPLETE | 2026-08-23 · `phases/PHASE-00-foundations.md` |
| P1 | Backend platform core | COMPLETE | 2026-08-23 · `phases/PHASE-01-backend-platform-core.md` |
| P2 | Flutter platform core | COMPLETE | 2026-08-23 · `phases/PHASE-02-flutter-platform-core.md` (Android build unverified — see §23) |
| P3 | Auth & identity | COMPLETE | 2026-08-23 · `phases/PHASE-03-auth-identity.md` |
| P4 | Wallet & ledger (test currency) | COMPLETE | 2026-08-23 · `phases/PHASE-04-wallet-ledger.md` |
| P5 | Real-time core | COMPLETE | 2026-08-23 · `phases/PHASE-05-realtime-core.md` |
| P6 | Game engine & contract | COMPLETE | 2026-08-23 · `phases/PHASE-06-game-engine.md` |
| P7 | Matchmaking & lobby | COMPLETE | 2026-08-23 · `phases/PHASE-07-matchmaking-lobby.md` |
| P8 | Casino game #1 — Crash (test currency) | COMPLETE | 2026-08-23 · `phases/PHASE-08-casino-game-crash.md` · OQ-05 decided: Crash · ADR-023, ADR-024 |
| P9 | Poker — NLHE cash (test currency) | COMPLETE | 2026-08-23 · `phases/PHASE-09-poker.md` · OQ-07 decided: NLHE cash · ADR-025 · blocker cleared first (ADR-023 §4b) |
| P10 | Risk & responsible gaming v1 | COMPLETE | 2026-08-23 · `phases/PHASE-10-risk-responsible-gaming.md` · ADR-026 (enforcement at the money boundary) · P9 debt closed: the table-escrow invariant is now checked by the reconciliation sweep, not only by tests |
| P11 | Notifications | NOT_STARTED | needs P5; transport = OQ-09 |
| P12 | Admin panel v1 | NOT_STARTED | needs P4; P10 now supplies the risk cases and RG state it reads, plus the deferrals P10 named for it (proactive queue eviction, evidence export, rule editing) |
| P13 | Distribution & updates (narrowed) | NOT_STARTED | server-side min-version enforcement only; channel owned by separate team |
| P14 | Hardening & load | NOT_STARTED | needs P8–P13; gates P18 |
| P15 | Compliance hand-off checkpoint | BLOCKED | external licensing team owns it; not an engineering gate |
| P16 | KYC integration | BLOCKED | PARKED by owner decision — verification skipped for now |
| P17 | Payments (real PSP) | BLOCKED | PARKED — direct-credit interim lands in P4 (ADR-022) |
| P18 | Real-money enablement & launch | BLOCKED | P14–P17 |
| P19 | Design integration | BLOCKED | UI-designer onboarding; needs P2 baseline |
| P20 | iOS | BLOCKED | OQ-04 (unscheduled) |

## Open-question status snapshot
See `docs/00-project/open-questions.md` for detail. **Decided/handled:** OQ-01 (delegated), OQ-02 (deferred; direct-credit interim), OQ-03 (deferred; L0 only), OQ-06 (AWS confirmed + local-first mandate). **Still open, none blocking current work:** OQ-04 (iOS), OQ-08..OQ-14. **Newly decided:** OQ-05 — **Crash** and OQ-07 — **No-Limit Hold'em cash tables**, both taken by engineering on the standing recommendations and both reversible at the cost of a game module plus its UI (see the OQ entries).
