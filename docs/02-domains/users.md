# Domain: Users (`users` module)

Phase: **P3** (core), extended by P10 (RG states), P16 (KYC fields). Purpose: the account identity record — profile, preferences, lifecycle. Deliberately thin: credentials live in `auth`, verified identity in `kyc`, money in `wallet`, risk state in `risk`/`responsible-gaming`. The user row is the join point, not a dumping ground.

## 1. Owned data (tables)

| Table | Key contents | Notes |
|---|---|---|
| `users` | id (UUIDv7), display_name, display_name_normalized (unique), country (ISO-3166, self-declared at signup), account_state (active/suspended/self_excluded/closed), state_reason, state_changed_at, created_at, closed_at | **minimal PII by design** — no legal name, no address, no phone here |
| `user_pii` | user_id (1:1), dob, legal_name, address fields — **populated only post-KYC (P16)**, columns encrypted at rest (app-layer envelope encryption; keys in secret manager, OQ-06) | separate table so PG grants + query paths for PII are isolated and auditable; most code never joins it |
| `user_preferences` | user_id, locale, timezone (display only), notification prefs (per class), gameplay prefs (table sounds, left/right layout etc.), marketing_consent + consent_timestamps | non-sensitive; freely editable |
| `user_state_history` | user_id, from_state, to_state, actor (user/admin/risk/rg/system), reason_code, created_at | append-only; every transition also audit-logged |

Self-declared `country` is a UX/config hint only; the enforced value post-P15 comes from geo checks + KYC (rule 13, `../06-compliance/jurisdiction-matrix.md`).

## 2. Exposed services / API surface

REST: `GET /users/me`, `PATCH /users/me` (display name, preferences), `GET /users/me/state`, `POST /users/me/close` (initiates closure, §5). No public user-lookup endpoints; opponents see only `display_name` + generated avatar via game/lobby payloads (`playerView` discipline — no user ids of strangers leak beyond opaque per-match seat refs where feasible).

In-process: `UsersService.get(userId)`, `UsersService.getState(userId)`, `UsersService.transitionState(userId, to, actor, reason)` (sole state mutator — called by admin, risk, RG, closure job), domain events `user.created`, `user.state_changed`, `user.closed`. `AccountStateGuard` (in `auth`) reads state via this service's cached view.

## 3. Display name / username rules

Single public handle (`display_name`), 3–20 chars, letters/digits/underscore, normalized (case-fold + confusable-skeleton) for uniqueness to block homoglyph impersonation. Deny-list: reserved words (admin/support/system), profanity list (jurisdiction-extendable). Rename allowed with cooldown (e.g. 30 days) and history kept (collusion investigations need old names); risk module notified on rename. Display name is **not** an email and never doubles as login identifier.

## 4. PII handling & encryption posture

**Problem.** Gambling platforms are PII honeypots; breach cost scales with what we store.
**Approach:** store the minimum that the product and (later) the license require. Pre-P16 the platform knows: email (in `auth`), display name, self-declared country, IPs (sessions). DOB/legal identity arrive only with KYC, preferentially **kept at the provider** (`./kyc-verification.md` §PII), with only verdict + minimal fields mirrored into `user_pii`, envelope-encrypted (per-user data keys wrapped by a KMS master key, OQ-06). PII never in logs (rule 15), never in JWT claims, never in WS payloads. Admin reads of `user_pii` are themselves audited (P12 read-audit).
**Alternatives:** full profile capture at signup (rejected: no product need, pure liability); pgcrypto column encryption (rejected as sole layer: keys would live too close to data). **Trade-off:** app-layer encryption blocks SQL-side filtering on PII fields — acceptable, those fields are never search keys (admin looks up by email hash/display name/user id).

## 5. Account lifecycle & closure

States + enforcement matrix: `./authentication.md` §7. Transition authority: user (→closed request, self-exclusion via RG), admin (suspend/reinstate, P12 four-eyes for reinstate-after-risk), risk engine (suspend/freeze), RG (self_excluded per its own rules — admin cannot shorten a self-exclusion term).

**Closure is a process, not a flag.** `POST /users/me/close` → `closure_requested`, then a checklist gate before `closed`:
1. **No open matches/seats** — must leave tables; seated buy-ins settle or void per game rules first (games/engine, never bypassed).
2. **Balance zero-out** — TST: forfeited to house via a `closure_forfeit` ledger transaction. Real money (post-P18): balance must be withdrawn (KYC permitting) or escalated to manual handling; **closure never deletes or strands money** — the ledger rows persist regardless (rule 5).
3. **No pending payments/withdrawals/chargebacks** (P17) and no active risk hold — a frozen account cannot self-close to evade investigation; closure parks as `closure_requested` until the hold clears.
4. RG note: closure requested during self-exclusion completes, but the exclusion record persists and re-registration checks against it (RG domain owns re-registration matching).
Terminal `closed`: login disabled, sessions/devices/refresh families revoked, personal data handled per §6, financial history retained per retention policy (OQ-01).

## 6. Data-subject rights readiness (export / delete)

Designed now, jurisdiction-tuned at P15 (`../06-compliance/`).
- **Export:** async job assembling profile, preferences, transaction history (read model, `./transactions.md`), session metadata, KYC verdict summary → downloadable bundle; delivery authenticated + audited.
- **Deletion vs ledger immutability:** the append-only ledger and audit log cannot be rewritten (rules 5, 15) and financial/AML retention is legally mandated (durations per OQ-01). Resolution: **pseudonymization** — ledger/audit/game rows reference only `user_id` (UUIDv7, meaningless alone); on erasure we delete/overwrite `user_pii`, preferences, display name (→ `deleted_user_xxxx`), email, device rows, and destroy the per-user encryption keys (crypto-shredding for anything encrypted), while retained rows keep the now-anonymous UUID for the mandated period. **Legal holds:** a per-user hold flag (risk/compliance-set, audited) suspends erasure and export-triggered deletions until released.
- The mapping "which stores hold what, keyed how" is maintained as a data inventory in `../06-compliance/` from P4 onward so P15 is a policy fill-in, not an archaeology dig.

## 7. Relationships to other domains

| Domain | Relationship |
|---|---|
| `auth` | owns credentials/sessions/devices; enforces `users` account state; user row created inside the registration transaction |
| `kyc` | writes verification level + minimal verified fields (via exported service, its own tables for process state); DOB lands in `user_pii` post-verification |
| `wallet` | accounts reference user_id; closure gate checks balances/escrow via wallet service — `users` never touches ledger tables (rule 20) |
| `responsible-gaming` | drives `self_excluded`, limit records, re-registration screening |
| `risk` | suspend/freeze transitions, rename/closure signals, legal holds |
| `notifications` | preference source for delivery; state-change notices |

## 8. Admin actions on users (P12 surface, planned now)

Search (email hash / display name / user id), view profile + state history, suspend/reinstate (reason mandatory, audited; four-eyes to reinstate risk-suspended), force-logout (delegates to auth revocation), case notes, PII reveal (role-gated, read-audited), initiate/approve closure edge cases, apply/release legal hold (compliance role). Every action → audit log with actor + reason (rule 15).

## 9. Failure / edge cases

- Registration race on display name: unique index on normalized name is the arbiter; retry with suggestion.
- State-change vs live gameplay: `user.state_changed` → realtime disconnect + matchmaking eviction; an in-flight *hand/round* completes or voids per game rules — money paths are blocked immediately, gameplay drains gracefully.
- Closure requested then user logs back in before finalization: allowed to cancel while in `closure_requested` (audited); not after `closed`.
- Erasure requested with retention-mandated data: pseudonymize + retain per §6; the response to the subject states exactly what is retained and under which obligation (template per jurisdiction, P15).

## 10. Phase mapping & open questions

- **P3:** `users`, `user_preferences`, state machine, display-name rules, closure (TST path). **P10:** RG-driven states. **P12:** admin surface. **P16:** `user_pii` population + encryption in force. **P15/P18:** retention/export/erasure policies finalized.
- OQs touched: **OQ-01** (retention durations, data-protection law, erasure limits), **OQ-06** (KMS for envelope encryption), **OQ-03** (which verified fields are mirrored vs provider-held).
