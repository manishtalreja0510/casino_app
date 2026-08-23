# Domain: Responsible Gaming (`responsible-gaming`)

Phase: **P10** (baseline, on test currency — rule 12: first-class domain, not a launch bolt-on) · **P18** (jurisdictional completion per license). The full per-license obligations matrix is deferred to `docs/06-compliance/responsible-gaming-obligations.md` (filled at P15/P18); this doc defines the mechanism that matrix configures.

## 1. Purpose

Give players enforceable control over their own play (limits, breaks, exclusion), meet jurisdiction-mandated RG duties (OQ-01), and prove — on test currency, long before real money — that every RG block is server-side and effective.

**Invariant (normative):** *RG blocks are enforced server-side and cannot be bypassed by any client or game code path.* Enforcement lives in the domain services other modules must call (§6); the client only renders RG state. A game, matchmaking shortcut, or admin convenience path that skips an RG check is a rule-1/rule-12 violation, not a bug to triage.

## 2. Owned data

Built in migration `0009_risk_rg` (P10). All tables live in the `rg` schema.

| Table | Contents |
|---|---|
| `rg.limits` | user_id, type (deposit/loss/wager/session_time), period (day/week/month), amount, origin (player / jurisdiction), pending_amount, pending_effective_at |
| `rg.limit_usage` | consumption per user/type/period/window: `spent` and `returned`, so a loss limit is one subtraction rather than a second counter that can disagree with the first |
| `rg.exclusions` | user_id, kind (cool_off / self_exclusion), starts_at, ends_at (null = permanent), source (player / admin / regulator-list at P18). **Protected by a database trigger**: no deletes, no shortening, no end date on a permanent exclusion — "we would never do that" is not a control |
| `rg.reality_check_prefs` | interval per user (within the allowed band), last_shown_at, last_ack_at |
| `rg.events` | append-only (enforced by trigger) record of RG-relevant occurrences — feeds the user-visible history + compliance evidence (distinct from the audit log; audit still records the sensitive mutations per rule 15) |

**Units.** Money limits are integer minor units, like everything else that touches money
(rule 4). A session-time limit is whole **minutes** — set, metered and displayed in the same
unit, so nothing converts and nothing rounds.

## 3. Limits model

Types: **deposit** (P17+ real meaning; faucet-credit limit stands in on test currency), **loss** (net loss per period), **wager** (total staked per period), **session-time** (continuous play minutes).

- **Per-period:** day / week / month, independently settable; the strictest applicable wins.
- **Two origins:** player-set and jurisdiction-mandated (defaults/caps from `docs/06-compliance/jurisdiction-matrix.md`; a player can always set *stricter* than the mandate, never looser).
- **Asymmetric application (standard regulatory pattern):** decreases apply **immediately**; increases (or removals) take effect only after a **cooling period** (jurisdiction-config, default 24h — state `pending_increase`, cancellable meanwhile). No admin override of the cooling period below jurisdiction minimum.
- Enforcement check is a single domain service call — `rg.checkAllowance(client, { userId, kind, amount })` — evaluated **inside the transaction that would commit the spend**, so the usage it reads cannot be stale and the usage it writes cannot outlive a rollback. It is called from the wallet's debit paths rather than from each caller (**ADR-026**), which is what makes "no code path reaches a stake commit without it" a structural fact rather than a convention.
- **Idempotency is resolved before the limit.** A replayed operation posts nothing, so it consumes no allowance (ADR-026 §4). Checking the limit first meant a retried buy-in was refused by a limit it had never spent — so the worse a player's connection, the smaller their limits effectively became.
- Session-time limits are metered by a sweep that counts a minute per connected player, once a minute; presence on the `/game` namespace is what defines "playing", so time does not run down while a player reads their wallet. Enforcement is at **play entry** (queue join, sit-down): never mid-action fund confiscation — the hand/round completes per game rules, then the block applies. Mid-session forced unseat is **not built** (see §9).

## 4. Reality checks

Periodic in-session interruption with play figures (today's stake and net). Server-pushed over WS to the player's own room (`user:{id}`) by a sweep on the instances that run scheduled work; the client renders and acknowledges, and both the showing and the acknowledgement are recorded in `rg.events`.

Three details are normative rather than incidental:

- **Only to a player who is there to see it.** A check is marked shown only when presence says the player is connected. Marking one shown starts the grace period after which play pauses, so marking one for an absent player would greet them on their return with a block for a message they were never sent.
- **A grace period, not an instant block.** An unacknowledged check pauses **new** play after 60 seconds. A player mid-hand is finishing something they already committed chips to.
- **One at a time.** A check already waiting for a tap is not replaced; re-marking it shown would keep pushing the grace period back for a player who is ignoring it.

The client cannot ask for a check, suppress one, or decide when one is due — it is told. Interval floors/ceilings are jurisdiction-configurable (5 minutes to 4 hours today); the player may tighten within that band.

## 5. Cool-off & self-exclusion

| | Cool-off | Self-exclusion |
|---|---|---|
| Duration | short (24h–6 weeks, config) | long (6 months+) or permanent |
| Entry | player, immediate, no cooling period | player (immediate) or admin/regulator (P18: mandated lists where license requires) |
| Reversal | none — expires | jurisdiction-dependent re-entry rules (config): permanent = never; term = expiry + possible re-entry friction (waiting period, positive re-request). Never lifted early, not even by superadmin |
| Effect | identical enforcement set, differing only in duration/reversibility | same |

**Immediate effects of either (server-side, same transaction as state change where applicable):**
- Account state → `self_excluded` (account-state model from P3), in the **same transaction** as the exclusion row, so there is no window in which the record exists and the block does not. A lapsed cool-off returns the account to `active` via a reconciliation sweep — enforcement never depended on the account state, but a week off must not leave a permanent label.
- **Sign-in stays open, deliberately** (changed in P10 from P3's refusal). An excluded player can sign in, see the exclusion, see when it ends, and reach support; every money and play path refuses them (ADR-026), so nothing is unlocked by letting them in. An exclusion a player cannot look at is a safety feature that produces support tickets and suspicion in equal measure. `suspended` and `closed` still cannot sign in — those are somebody else's decision about the player, not the player's own.
- Matchmaking, poker sit-down and every wallet debit refuse from the next action onwards. **Not built:** proactive queue removal, seat cancellation and forced unseat. A stale queue entry cannot turn into a seat — formation charges a buy-in, and the buy-in is refused — so the gap costs a player a queue row that never matches, not a hand they should not have played. Proactive eviction lands with the admin tooling in P12.
- Faucet blocked immediately; at P17: deposits blocked immediately; marketing notifications suppressed (`notifications` non-optoutable RG class still delivers exclusion confirmations — there are no notifications before P11).
- **Not built:** pushing an RG event to live sockets and evicting them from `/game` rooms. The refusal arrives on the player's next action instead.

Exclusion state is checked at every enforcement point (§6) — not just at entry — so a mid-session exclusion takes effect within one action, not at next login.

## 6. Enforcement points (the domains that MUST consult RG)

| Domain | Check |
|---|---|
| `auth` | login: excluded accounts may sign in (§5) and are refused everywhere that matters; a session start is reported to the risk engine as a graph edge |
| `matchmaking` | queue join: `rg.checkPlayEntry` — exclusion, unacknowledged reality check, session-time limit. The stake itself is checked again when the wallet takes it |
| `game-engine` | buy-in / stake commit: wager & loss limit allowance (via wallet path) |
| `wallet` | **the boundary itself (ADR-026)**: `addFunds`, `buyIn` and `sitDown` each check exclusion + the applicable limit and meter usage in-transaction. A game cannot forget this check because it never knew about it |
| `poker` | sit-down: play entry (exclusion, reality check, session time) before a seat is taken |
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
| **P10** | **shipped**: limits (deposit/loss/wager/session-time × day/week/month) with the cooling-period asymmetry; reality checks pushed over WS; cool-off and self-exclusion with database-enforced irreversibility; enforcement at the money boundary (ADR-026) and at play entry; player UI (limits with usage, breaks with typed confirmation, reality-check interval, history). **Not shipped, deliberately**: mid-session forced unseat on a session-time limit (entry is blocked instead), the DOB placeholder gate, and queue removal on exclusion (an excluded player is refused at every entry and every debit, so a stale queue entry cannot become a seat) |
| P12 | admin RG tooling |
| P15 | jurisdiction matrix values chosen with counsel; obligations matrix drafted (`docs/06-compliance/responsible-gaming-obligations.md`) |
| P16 | real age verification via KYC levels |
| P17 | deposit limits bind to real deposits; withdrawal-while-excluded policy configured |
| **P18** | license-mandated defaults, mandatory messaging, regulator exclusion-list integration where required; obligations matrix completed and verified |

**Testing (P10 acceptance, from roadmap):** all four criteria are asserted in `apps/api/test/integration/rg.int-spec.ts` against real PostgreSQL and Redis — self-exclusion blocks funding, staking, queueing and sitting down within one action; a limit decrease binds in-transaction; an increase is held for its cooling period while the old limit keeps applying; and no code path reaches a stake commit without `rg.checkAllowance`, which the last test asserts by driving every wager path there is and checking each one metered.
