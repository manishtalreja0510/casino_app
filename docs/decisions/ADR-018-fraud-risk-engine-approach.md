# ADR-018: Fraud/Risk Engine Approach

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

A real-money multiplayer platform will face multi-accounting, bonus abuse, stolen payment instruments, bot play, and poker-specific collusion/chip-dumping. We have no labeled fraud data yet, no PSP (OQ-02), and a client that is untrusted by definition — its hardening telemetry is a signal, never a verdict (rule 1). Risk plumbing must mature on test currency long before real money flows (P10 « P18).

## Decision

- **Rules-based scoring v1** over a **signal-ingestion pipeline**: all signals (client hardening telemetry — root/hook/emulator/signature-check results, Play Integrity per OQ-12; velocity of deposits/logins/matches; device/IP/network graphs; gameplay statistics) flow into the `risk` module, are persisted, and are evaluated by **configurable weighted rules** (weights/thresholds in DB-backed config, changeable without deploys, changes audit-logged).
- **Action ladder:** `allow → flag → limit → review → freeze` (freeze = per-user kill-switch). Actions attach at user/session/device scope; every action is audit-logged and reversible through admin.
- **Manual-review queues** in the admin panel (P12): flagged users, withdrawal holds, collusion cases — with the evidence trail attached.
- **Client signals only ever degrade or flag — never hard-block.** A rooted or de-Googled device raises score and may limit stakes/withdrawals pending review; it never denies service by itself (false positives on legitimate devices are certain).
- **Poker collusion heuristics** from server-side truth: hand histories, seating patterns (same IP/device/network repeatedly seated together), chip-flow statistics (consistent transfer patterns, abnormal fold-to-raise vs specific opponents), synchronized session timing. Output: review-queue cases, not auto-bans.
- **ML deferred** until real labeled outcome data exists (confirmed fraud from review queue + PSP chargebacks post-P17); the signal pipeline is designed to become the feature store when that day comes.

## Alternatives considered

- **Third-party fraud SaaS now** (Sift/SEON-class) — deferred: real cost, and its highest-value inputs (payment instruments, chargebacks) don't exist pre-PSP; revisit at P15 alongside PSP selection — it would consume the same signal pipeline.
- **ML-first** — rejected: no labeled data, no baseline; an unexplainable model is also hard to defend to regulators and reviewers. Rules are inspectable and tunable from day one.
- **Nothing until real money** — rejected: abuse patterns (multi-accounting, bots, collusion) appear on test currency, and the pipeline, queues, and heuristics need maturation time; retrofitting risk at P18 is how launches slip.

## Consequences

- v1 catches script-kiddie and pattern-obvious abuse; sophisticated fraud requires analyst iteration on rules — the review queue is the learning loop and the future ML training-label source.
- Config-driven weights mean fast tuning but require discipline: threshold changes are audit-logged and 4-eyes for freeze-class rules.
- Degrade-don't-block on client signals accepts that some hostile devices play on; server authority (rules 1–2) bounds what they can steal to nothing outcome-relevant.
- Collusion detection produces probabilistic cases; human review cost is accepted as unavoidable in poker.

## Links

- ../02-domains/fraud-risk.md, ../02-domains/responsible-gaming.md, ../04-security/mobile-app-hardening.md, ../02-domains/admin.md
- ../00-project/open-questions.md (OQ-02, OQ-12), ../00-project/system-rules.md (rules 1, 15)
- ADR-013-network-security-model.md, ADR-017-offstore-distribution-and-forced-update.md · Phases: P10, P12, P15, P17
