# Domain: Responsible Gaming (`responsible-gaming`)

Phase: **P10** (baseline, on test currency — rule 12: first-class domain, not a launch bolt-on) · **P18** (jurisdictional completion per license). The full per-license obligations matrix is deferred to `docs/06-compliance/responsible-gaming-obligations.md` (filled at P15/P18); this doc defines the mechanism that matrix configures.

## 1. Purpose

Give players enforceable control over their own play (limits, breaks, exclusion), meet jurisdiction-mandated RG duties (OQ-01), and prove — on test currency, long before real money — that every RG block is server-side and effective.

**Invariant (normative):** *RG blocks are enforced server-side and cannot be bypassed by any client or game code path.* Enforcement lives in the domain services other modules must call (§6); the client only renders RG state. A game, matchmaking shortcut, or admin convenience path that skips an RG check is a rule-1/rule-12 violation, not a bug to triage.

## 2. Owned data

| Table | Contents |
|---|---|
| `rg_limits` | user_id, type (deposit/loss/wager/session_time), period (day/week/month), amount or minutes, origin (player_set / jurisdiction_mandated), state (active / pending_increase), effective_at, requested_at |
| `rg_limit_usage` | rolling consumption per user/type/period (derived; recomputable from ledger + session data — cached truth for fast checks, reconciled by job) |
| `rg_exclusions` | user_id, kind (cool_off / self_exclusion), duration or permanent, starts_at, ends_at?, source (player / admin / regulator-list at P18), state |
| `rg_reality_check_prefs` | interval per user (within jurisdiction floor/ceiling), last_shown_at per session |
| `rg_events` | append-only record of RG-relevant occurrences (limit hit, check shown/acknowledged, exclusion started) — feeds user-visible history + compliance evidence (distinct from the audit log; audit still records the sensitive mutations per rule 15) |

## 3. Limits model

Types: **deposit** (P17+ real meaning; faucet-credit limit stands in on test currency), **loss** (net loss per period), **wager** (total staked per period), **session-time** (continuous play minutes).

- **Per-period:** day / week / month, independently settable; the strictest applicable wins.
- **Two origins:** player-set and jurisdiction-mandated (defaults/caps from `docs/06-compliance/jurisdiction-matrix.md`; a player can always set *stricter* than the mandate, never looser).
- **Asymmetric application (standard regulatory pattern):** decreases apply **immediately**; increases (or removals) take effect only after a **cooling period** (jurisdiction-config, default 24h — state `pending_increase`, cancellable meanwhile). No admin override of the cooling period below jurisdiction minimum.
- Enforcement check is a single domain service call (`rg.checkAllowance(userId, opType, amount)`) evaluated inside the same flow that would commit the spend — wallet/payments call it before ledger writes; race-safe because usage counters update in the same PG transaction as the spend they meter.
- Session-time limits enforced by the server timer framework (P5): warning event → grace → forced unseat per game's disconnect/sit-out policy; never mid-action fund confiscation — the hand/round completes per game rules, then the block applies.

## 4. Reality checks

Periodic in-session popup with play stats: session duration, hands/rounds played, net win/loss (test or real). Server-triggered over WS (`user:{id}` room) at configured interval; client renders and must acknowledge; acknowledgment recorded in `rg_events`. Not dismissible by game UI code; unacknowledged check pauses matchmaking eligibility for that session. Interval floors/ceilings jurisdiction-configurable; player may tighten.

## 5. Cool-off & self-exclusion

| | Cool-off | Self-exclusion |
|---|---|---|
| Duration | short (24h–6 weeks, config) | long (6 months+) or permanent |
| Entry | player, immediate, no cooling period | player (immediate) or admin/regulator (P18: mandated lists where license requires) |
| Reversal | none — expires | jurisdiction-dependent re-entry rules (config): permanent = never; term = expiry + possible re-entry friction (waiting period, positive re-request). Never lifted early, not even by superadmin |
| Effect | identical enforcement set, differing only in duration/reversibility | same |

**Immediate effects of either (server-side, same transaction as state change where applicable):**
- Account state → `self-excluded` (account-state model from P3, `docs/01-architecture/backend-architecture.md`); login allowed only to a restricted surface (view history, manage exclusion, contact support, withdraw at P17 where license permits) — **login-to-play blocked**.
- Matchmaking: removed from queues, seat reservations cancelled; current hand/round completes per game rules, then forced unseat.
- Faucet blocked immediately; at P17: deposits blocked immediately; marketing notifications suppressed (`notifications` non-optoutable RG class still delivers exclusion confirmations).
- Active WS sessions receive an RG event and are transitioned out of `/game` rooms.

Exclusion state is checked at every enforcement point (§6) — not just at entry — so a mid-session exclusion takes effect within one action, not at next login.

## 6. Enforcement points (the domains that MUST consult RG)

| Domain | Check |
|---|---|
| `auth` | login: excluded accounts → restricted session scope; session-time metering starts |
| `matchmaking` | queue join / seat reservation: exclusion + session-time + wager-limit headroom |
| `game-engine` | buy-in / stake commit: wager & loss limit allowance (via wallet path) |
| `wallet` | faucet credit: deposit-limit stand-in + exclusion; all debits meter loss/wager usage in-transaction |
| `payments` (P17) | deposit intent: deposit limit + exclusion; withdrawal: never RG-blocked (excluded users can withdraw where license permits — config) |
| `notifications` | RG notices are a non-optoutable class; marketing suppressed for excluded users |

Cross-module access follows module rules: exported `responsible-gaming` domain services, no direct table reads.

## 7. Age verification & KYC interplay

- Age verification is delivered by KYC (`docs/02-domains/kyc-verification.md`): **L0 (no KYC) = test currency only**; any real-money action requires L1+ which includes age.
- **OQ-01 interplay (flagged):** some regimes require an age gate even for free/test play. Modeled as jurisdiction config `rg.age_gate_free_play` (default off): when on, even test-currency play requires a minimal age attestation or KYC age check. Config exists at P10; real values at P15/P18. Until then a self-attested DOB gate at signup is the placeholder (P10), honestly documented as not verification.

## 8. User-visible surface & admin tooling

- **Player UI (P10):** RG section — current limits + usage bars, limit editing (with immediate/cooling-period semantics explained), reality-check interval, cool-off/self-exclusion flows with explicit confirmation friction (type-to-confirm for permanent), RG event history. Screens from `ui_kit`, thin shells per rule 25.
- **Admin (P12):** read: RG state per user (support role); write: apply mandated exclusions, adjust jurisdiction defaults (ops/superadmin per capability matrix, `docs/02-domains/admin.md`) — all audited; **no admin action may loosen a player's own restriction** (lift exclusions early, raise limits inside cooling period).
- RG state changes are audit-logged (rule 15) and emit `rg_events` for the user-visible history.

## 9. Phase mapping

| Phase | RG scope |
|---|---|
| P3 | account states include `self-excluded`; enforcement hook points stubbed |
| **P10** | full baseline on test currency: limits (faucet/loss/wager/session-time), reality checks, cool-off, self-exclusion, enforcement at all §6 points, player UI, DOB placeholder gate |
| P12 | admin RG tooling |
| P15 | jurisdiction matrix values chosen with counsel; obligations matrix drafted (`docs/06-compliance/responsible-gaming-obligations.md`) |
| P16 | real age verification via KYC levels |
| P17 | deposit limits bind to real deposits; withdrawal-while-excluded policy configured |
| **P18** | license-mandated defaults, mandatory messaging, regulator exclusion-list integration where required; obligations matrix completed and verified |

**Testing (P10 acceptance, from roadmap):** self-exclusion blocks matchmaking + faucet immediately; limit decrease effective in-transaction; increase held for cooling period; no code path reaches a stake commit without `rg.checkAllowance`.
