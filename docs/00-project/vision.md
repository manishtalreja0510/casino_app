# Vision

## What it is
A real-time, real-money gaming platform where players compete against strangers in skill and casino-style games. Android-first Flutter app distributed **off-store** (direct APK download, in-app updater, server-side forced update); NestJS backend, server-authoritative for every outcome, balance, timer, and piece of hidden information. Launch with two games — one casino-style game (OQ-05, rec. Crash) and multiplayer poker (OQ-07, rec. NLHE cash tables) — scaling to ~10 games through a single `GameDefinition` contract (ADR-009): each new game is a content plug-in, not a platform change.

## Who it's for
- **Players:** mobile-first users who want fast, fair, real-stakes multiplayer games against real opponents — in whichever jurisdiction(s) licensing permits (OQ-01).
- **Operators (us):** a small team running the whole platform through the admin panel — flags, kill-switches, risk queues, reconciliation — without SQL access.
- Development audience today: future developers and AI agents building against these docs.

## What success looks like
- All P0–P14 phases complete **entirely on `TST` test currency**: both launch games playable end-to-end vs strangers, surviving instance kills mid-hand with zero ledger drift, passing load (P14 targets) and pen-test gates.
- Compliance gate closes (P15: OQ-01/02/03 decided with counsel), KYC + PSP integrate cleanly behind their ports (P16/P17), and `compliance.real_money_enabled` flips ON via four-eyes for a staged limited launch (P18) in licensed geos only.
- Adding game #3..#10 requires only a new `GameDefinition` module + UI — no engine, wallet, or matchmaking changes.
- The forced-update channel works every release; an off-store fleet is patchable within days.

## What it is NOT
- **Not on app stores at launch.** Distribution is our own domain: signed manifest, checksummed APKs, in-app updater (P13).
- **Not on iOS at launch.** P20 is unscheduled, blocked on OQ-04.
- **Not real money until licensed.** No real-money enablement, PSP integration, or KYC provider selection beyond planning before OQ-01/02/03 close (system rule 11). Everything ships and hardens on test currency first.
- Not microservices, not crypto payments, not visually polished before the designer (P19).

## Three strategic bets
1. **Server-authoritative platform quality.** Ledger correctness, event-sourced game recovery, contract-driven games, and honest security posture ("raises attacker cost") are the product moat — trust is the only durable differentiator in real-money gaming.
2. **Off-store distribution control.** Owning the channel avoids store gambling policies and 30% cuts, at the price of install friction and self-owned update/security burden — accepted and engineered for (P13, rule 17).
3. **Compliance-gated staged rollout.** Build and harden everything on test currency in parallel with the business/licensing track; real money is a configuration flip behind a master gate, not a rebuild. If OQ-01 lands badly, the sunk cost is a working platform, not a stranded license.
