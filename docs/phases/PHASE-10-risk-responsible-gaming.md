# Phase 10 — Risk & Responsible Gaming v1 (test currency)

## 1. Phase overview
Two domains in one phase, because they share enforcement points and neither is useful
alone: **responsible gaming** (`docs/02-domains/responsible-gaming.md`) gives players
enforceable control over their own play, and **risk** (`docs/02-domains/fraud-risk.md`,
ADR-018) turns signals from every other module into scores and a graduated action ladder.
Roadmap: `docs/MASTER_ROADMAP.md` P10. Both run on `TST`, long before real money — which is
the point: rule 12 makes RG a first-class domain rather than a launch bolt-on, and the only
way to know a block works is to have been blocking with it for months.

## 2. Current status
`COMPLETE` — 2026-08-23. Mirrored in `docs/progress.md`.

## 3. Objective
Every money and play path in the platform consults RG and risk **structurally** — not by
each caller remembering to. A self-excluded player cannot fund, stake, queue or sit within
one action of excluding themselves. A limit decrease binds immediately and an increase waits
out its cooling period. A frozen account cannot move money and always has a case and a
support path. And no game, present or future, can skip any of it.

## 4. Dependencies
| Dep | Needed for | Verified state |
|---|---|---|
| P3 auth | account states, sessions, device/IP for the identity graph | COMPLETE |
| P4 wallet | the debit/credit paths RG meters and risk gates | COMPLETE |
| P7 matchmaking | queue-join enforcement point | COMPLETE |
| P8 Crash / P9 poker | real gameplay to meter, and poker's collusion surface | COMPLETE |
| OQ-01 | jurisdiction values for limits and AML thresholds | **Delegated** — the mechanism is built and its values left empty (§9) |
| OQ-12 | Play Integrity | Open — the signal type exists in the catalog and nothing emits it |

## 5. Preconditions
- Migrations at `0008`; `0009_risk_rg` is this phase's forward step.
- `compliance.real_money_enabled` OFF. Deposit limits stand in on the faucet path (ADR-022).

## 6. Existing-code analysis
- `AuthService.assertUsable` rejects any non-`active` account, so a self-excluded player
  cannot log in **at all**. `responsible-gaming.md §5` requires the opposite: login to a
  restricted surface, so they can see their exclusion and reach support. Changing this is in
  scope, not a nice-to-have — an exclusion the player cannot see or ask about is a support
  problem disguised as a safety feature.
- Every game reaches money through `WalletService` — `addFunds`, `buyIn`, `sitDown`. That is
  the structural chokepoint the acceptance criterion ("no code path reaches a stake commit
  without `checkAllowance`") needs. Putting the check at each call site would make it a
  thing to remember; putting it in the wallet makes it a thing that cannot be forgotten.
- Poker records `poker.hands` with per-hand awards. Risk must **not** read that table
  (rule 20): poker emits a signal instead, and risk aggregates from its own store.

## 7. Scope
1. **`0009_risk_rg`** — `rg` and `risk` schemas; seeded default rules.
2. **RG limits** — deposit (faucet stand-in), loss, wager, session-time; day/week/month;
   decrease immediate, increase after a cooling period; the strictest applicable wins.
3. **`rg.checkAllowance`** — one call, evaluated inside the transaction that commits the
   spend, metering usage in the same transaction.
4. **Cool-off and self-exclusion** — immediate, server-side, irreversible within their term;
   account state, queue removal, faucet and stake blocks.
5. **Restricted login** for excluded accounts, so exclusion is visible and supportable.
6. **Reality checks** — interval preference, server-emitted over WS, acknowledged by the
   player, recorded; unacknowledged blocks *new* play (never mid-hand).
7. **Risk signals** — ingestion service and an authed client-hardening endpoint; append-only
   store with weights and TTLs assigned by rules, never by the emitter.
8. **Scoring and the action ladder** — `allow → flag → limit → require-review → freeze`,
   with the normative rule that **client-only evidence can never freeze** enforced
   structurally rather than by policy.
9. **Identity graph** — device and IP edges from sessions; shared-device and shared-IP
   signals with dampening.
10. **Velocity** — faucet claim frequency and volume.
11. **Poker collusion v1** — chip-flow asymmetry and co-seating, from hand-completion
    signals, weighted much higher when the pair is already linked in the graph.
12. **Cases** — every freeze creates one, with an evidence bundle. No freeze without a
    review path.
13. **Enforcement** — wallet, matchmaking, crash and poker entry points consult both
    domains through exported services.
14. **Flutter** — an RG screen: limits with usage, cool-off and self-exclusion with
    confirmation friction, reality-check interval, RG history.
15. **Docs** — ADR-026 if the enforcement placement warrants one (§9), domain docs
    reconciled, flow map, progress, completion report.

## 8. Out of scope
Per both domain docs: ML scoring, KYT vendors, chargebacks, real deposit limits (P17),
jurisdiction values (P15/P18), the admin review UI (P12 — cases are created and queryable,
not worked). Plus: regulator exclusion lists, AML report generation beyond the config shape,
and marketing-notification suppression (there are no notifications until P11).

## 9. Architecture considerations
**ADR-026 — Enforcement at the money boundary.** RG and risk checks live *inside* the wallet
service's debit paths rather than at each caller. The alternative — a check at every game,
matchmaking path and controller — is one `if` away from a hole, and the hole would be in a
game written months later by someone who never read this document. Games keep no
RG-awareness at all, which is also what keeps rule 12 true as games are added.

Module direction is one-way and deliberate: `wallet → rg`, `wallet → risk`, and emitters
(`auth`, `poker`, `wallet`) push signals *into* risk. Risk reads no other module's tables;
poker's collusion surface arrives as signals, not as a join.

## 10. Database changes
`0009_risk_rg` — two schemas, both additive, no change to any existing table except one
column and one narrowed index that P9 had already introduced.

**`rg`**: `limits` (with `pending_amount` / `pending_effective_at` carrying the cooling
period), `limit_usage` (per user/type/period/window, `spent` and `returned`), `exclusions`,
`reality_check_prefs`, `events`.

**`risk`**: `rules` (seeded), `signals`, `actions`, `cases`, `device_links`, `ip_links`.

Three triggers do work that code must not be trusted with:

- `rg.protect_exclusions()` — an exclusion cannot be deleted, cannot be shortened, and a
  permanent one cannot be given an end date. Not by a service, not by an admin, not by a
  superadmin with `psql`.
- `rg.reject_event_mutation()` and `risk.reject_signal_mutation()` — `rg.events` and
  `risk.signals` are append-only. Evidence that can be edited is not evidence.

## 11. Backend changes
- **`responsible-gaming`** (new): `RgService` (allowance checks, metering, play entry,
  exclusions, reality checks, three sweeps), `RgRepository` (the only place `rg.*` is
  touched), `RgController` (the player's own controls — every endpoint acts on the caller,
  so there is no request shape that sets someone else's limits).
- **`risk`** (new): `RiskService` (ingest, score, ladder, gate, identity graph, gameplay
  review), `RiskRepository`, `collusion.ts` (pure heuristics, unit tested),
  `RiskController` (the client hardening report and a deliberately uninformative `me`).
- **`wallet`**: `postSpend` — one private helper through which every debit path now runs:
  resolve idempotency, then ask RG, then post, then meter. `settle` meters returns, which is
  what makes a loss limit net. `ReconciliationService` gained a fifth check and a
  registration hook for it.
- **`auth`**: `assertUsable` admits `self_excluded`; `onSessionStarted` lets risk observe a
  login without auth depending on risk.
- **`matchmaking`**, **`poker`**: `requirePlayEntry` before a queue join and a sit-down.
- **`realtime`**: `PresenceService.connectedUsers()`, for the two sweeps that need to know
  who is actually playing.

## 12. Flutter changes
`rg_models.dart` and six client methods; `rg_providers.dart`; `ResponsibleGamingScreen` at
`/playing-safely`, linked from Home; `RealityCheckListener` mounted above the router.

The screen decides nothing. No limit arithmetic, no cached "remaining", no local idea of
whether play is allowed — all three would be a second copy of a server decision, and a
second copy can only ever be wrong in the player's favour.

## 13. API changes
`GET /rg`, `POST /rg/limits`, `POST /rg/limits/cancel-pending`, `POST /rg/exclusions`,
`POST /rg/reality-check/interval`, `POST /rg/reality-check/acknowledge`,
`POST /risk/client-report`, `GET /risk/me`. All authenticated, all acting on the caller.

## 14. WebSocket changes
One server-pushed event, `rg:reality_check`, to the player's own room. No new client event:
a client cannot ask for a check, acknowledge over the socket, or suppress one.

## 15. Security considerations (MANDATORY)

### Threats this phase introduces

| Threat | Control | Proven by |
|---|---|---|
| A game path that skips an RG check | Checks live inside the wallet's debit paths (ADR-026); games never learn the domains exist | `rg.int-spec.ts` "meters every wager path, whichever module asked" |
| Setting or lifting someone else's limits | No endpoint takes a user id; the actor comes from the token | `rg.controller.ts` shape; auth guard tests |
| Shortening or deleting an exclusion (including by an admin, including by hand) | Database trigger | `rg.int-spec.ts` "cannot be shortened or deleted, by anyone" |
| A permanent exclusion given an end date | Database trigger | `rg.int-spec.ts` |
| A compromised client freezing accounts by reporting problems | `freeze` reads `serverEvidence` only; client-only weights sum to 100 against a threshold of 120 | `risk.int-spec.ts` "cannot freeze an account, however much of it there is" + the arithmetic test |
| An emitter inflating its own signal's weight | Weights come from `risk.rules`; the payload is never read for them | `risk.int-spec.ts` "weighs a signal by the rule, never by what the emitter claims" |
| A typo becoming a restriction | An unknown signal type is dropped, not stored with a guessed weight | `risk.int-spec.ts` "drops a signal type nobody has assigned a meaning to" |
| Editing evidence after an action | `risk.signals` and `rg.events` append-only by trigger; the weight and the score are frozen into the action and the case | `risk.int-spec.ts` append-only test; `applyAction` evidence |
| Learning which check fired (an oracle) | `flag` and `require_review` are invisible; refusals name no rule, signal or score | `risk.int-spec.ts` "never discloses the score, the rules, or which signal fired" |
| A freeze with no way back | Every freeze opens a case in the same transaction, and the refusal carries the support path | `risk.int-spec.ts` "opens a case in the same breath" |
| A retry eating a player's limit | Idempotency resolved before the allowance check | `rg.int-spec.ts` "does not meter a replayed operation twice" |
| A block for a message never sent | A reality check is marked shown only to a connected player | `rg.int-spec.ts` "is not marked shown for a player who was never sent it" |

**Threat-model delta:** one new inbound channel from an untrusted process (the client
hardening report) — authenticated, weighed by server rules, and structurally incapable of
freezing anything. No new external dependency. No new PII: signals carry opaque ids, the
identity graph stores a device id and an address without linking either to a name, and RG
events carry amounts and types rather than anything about a person.

### Checklist (`docs/04-security/security-checklist.md`)

**A. Every phase** — [x] Authz on all eight new endpoints (global guard; actor from the
token, never the body). [x] Input validation via zod, including the typed confirmation on
anything irreversible. [x] Rate limits: existing read/write classes, no new class. [x] Audit:
limit changes, exclusions and every risk action append to the hash-chained log; the RG event
log is separate and player-visible. [x] No PII in logs or payloads. [x] No new secrets.
[x] Errors carry no internals — deliberately so here, since a detailed refusal *is* the
vulnerability. [x] No new dependencies. [x] Threat delta above. [x] `verify:all` green.

**B. Financial** — [x] Idempotency: unchanged, and now resolved *before* the limit check so
a replay consumes nothing. [x] Concurrency: allowance and metering happen inside the caller's
transaction; risk decisions are serialised per user by an advisory lock. [x] Ledger
invariants unchanged. [x] Reconciliation: a fifth check closes P9's open debt — table escrow
against the game's own figure, with a test that breaks the invariant deliberately and
asserts the sweep catches it. [x] Four-eyes: N/A. [x] Rounding: N/A — RG counts money in
the same integer minor units it moves in, and session time in whole minutes.

**C. Game** — [x] Conformance unchanged and green. [x] Information hiding: RG and risk add
no game state and no new view. [x] RNG: untouched. [x] Timers: the three sweeps are
scheduled work, gated by `SCHEDULED_WORK_ENABLED`, and none of them is authoritative for
anything — enforcement reads the tables directly. [x] Kill-switch: untouched.

**D. Client** — [x] No hardcoded styles (executable test). [ ] APK string-dump and
[ ] obfuscation — see §23; open, not waived. [x] Hardening signals: the report endpoint is
new in this phase and is treated as evidence from an untrusted process throughout.
[x] Client validates for UX only: the typed confirmation exists on both sides, and neither
trusts the other's.

## 16. Edge cases
A limit set to zero (valid — it blocks everything of that kind). A pending increase whose
time arrives between two requests (promoted on read, not by a sweep). A player excluded
while queued (the queue entry cannot become a seat, because formation charges a buy-in that
is refused). A cool-off lapsing while the player is signed in (enforcement stops at the
second; the account label follows within a minute). A reality check due while nobody is
connected (not shown, not marked). A signal for a user who no longer exists (foreign key
refuses; the hand still settles). Two emitters evaluating one user at the same moment (the
advisory lock makes one of them a no-op).

## 17. Testing strategy
`collusion.spec.ts` (13) for the heuristics; `rg.int-spec.ts` (23) and `risk.int-spec.ts`
(19) against real PostgreSQL and Redis; `rg_screen_test.dart` (7) for the client's restraint;
one added case in `poker.int-spec.ts` for the reconciliation check. The two normative claims
— client evidence can never freeze, and no freeze without a case — are written adversarially
rather than as coverage.

## 18. Implementation plan
Migration → RG service and repository → wallet integration → risk service → emitters →
enforcement points → sweeps → client → docs. Done in that order, with the integration suites
written before the client so the server's behaviour was pinned first.

## 19. Rollback / recovery
The migration is additive; dropping the two schemas removes the feature and nothing else. If
RG or risk had to be disabled in a hurry, the wallet's calls are the only enforcement path
and the rules table is the only knob — `risk.rules.enabled = false` stops scoring without a
deploy. Exclusions are deliberately not reversible by any mechanism, including this one.

## 20. Acceptance criteria
1. Self-exclusion blocks funding, staking, queueing and sitting down within one action. ✅
2. A limit decrease binds in-transaction; an increase waits out its cooling period while the
   old limit keeps applying. ✅
3. No code path reaches a stake commit without `checkAllowance`. ✅
4. A frozen account cannot move money, and always has a case and a support path. ✅
5. Client-only evidence can never freeze an account. ✅
6. Synthetic collusion and chip-dump scenarios are detected. ✅

## 21. Definition of done
Scope implemented, tests green, security checklist run, docs and flow map updated, ADR-026
written, completion report below, and no next phase started.

## 22. Completion report
**Status: COMPLETE — 2026-08-23.** All six acceptance criteria met. `verify:all` green,
twice in a row (the second run for flakiness — three of P8's and P9's defects surfaced only
on a repeat): lint, typecheck, 224 API unit tests, 11 contract tests, build, migrations,
201 API integration tests, `flutter analyze`, 39 app widget tests, 28 `ui_kit` tests,
28 `api_client` tests, secret scan.

### What was built
Both domains, end to end, plus the enforcement placement that makes them structural rather
than remembered (ADR-026). The player-facing half is a screen and a modal; the half that
matters is that neither can be gone around.

### Defects found and fixed in this phase
Seven, five of them in code written earlier in this phase and two carried from before. Each
was found by a test written to be adversarial rather than confirmatory:

1. **A retried spend ate a limit it never spent.** The allowance check ran before the ledger's
   idempotency check, so a buy-in retried after a dropped response was refused by a wager
   limit that the replay would not have consumed. The worse a player's connection, the
   smaller their limits effectively became. Fixed by resolving the replay first
   (`WalletService.postSpend`), which also removed three copies of the check/post/meter
   sequence.
2. **A loss limit counted gross, not net.** `settle` — the pooled path every matchmade game
   uses — never metered returns, so winning money back did not reduce a loss. Only the
   house-banked and table paths had it.
3. **Matchmaking imported `RgService` and never called it.** The injection was added and the
   call forgotten, which is exactly the failure ADR-026 is written about — and it happened
   inside the phase that wrote the ADR.
4. **Two evaluations could apply the same rung twice**, producing two freezes, two audit
   entries and two cases for one player. `evaluate` is read-then-write and several emitters
   evaluate the same user at once by design. Fixed with a per-user advisory lock and a
   re-read inside it.
5. **A lapsed cool-off left the account labelled `self_excluded` forever.** Enforcement was
   correct to the second, but nothing ever revisited the account state, so a week off was a
   permanent label.
6. **The "client signals cannot freeze" margin did not exist.** The comment claimed the
   freeze threshold was above the sum of every client-only weight; both were exactly 100. The
   arithmetic defence was decoration. Threshold raised to 120, with a test that fails the day
   somebody closes the gap again.
7. **`session_time` was a limit in name only** — settable through the API and the DB,
   enforced by nothing. Now metered a minute at a time against whoever is connected, and
   enforced at play entry.

### P9 debt closed
The table-escrow invariant (`escrow == Σ stacks`) was asserted only in P9's tests. It is now
the reconciliation sweep's fifth check, fed by a figure the poker module declares rather than
by the wallet reading `poker.seats` — so it stays true of real tables, not only of the hands
the test file plays, and adding another table-banked game needs no change to reconciliation.

## 23. Known limitations
- **Android build still unverified** (carried from P2 §23). `flutter build apk` was attempted
  again this phase: Flutter is installed, but `/opt/android-sdk` contains an empty
  `cmdline-tools` directory and no platform or build-tools, and fetching them needs
  `dl.google.com`, which this environment cannot reach. So the APK string-dump and
  obfuscation checks in §15 D remain **open, not waived** — they need an SDK-equipped
  environment, not a decision.
- **Mid-session forced unseat** on a session-time limit is not built; entry is blocked
  instead, so a player already at a poker table can finish the session they are in.
- **Proactive eviction on exclusion** (queue removal, seat cancellation, socket eviction) is
  not built. An excluded player is refused at every entry and every debit, so a stale queue
  entry cannot become a seat — but they are not *told* until they act. P12.
- **No per-session risk scoring.** The schema carries `session_id`; nothing degrades a single
  session while leaving the account alone.
- **Network signals** (IP reputation, geo velocity, VPN/Tor) are catalogued and unbuilt —
  every one needs a data source that does not exist yet.
- **Evidence is stored, not exported.** Packaging a case for a regulator is P12's, with the
  UI that reads it.
- **The age-verification placeholder was not built.** A self-attested date of birth is not
  verification, and KYC is parked by owner decision; building it would have added a control
  in name only, which is the specific failure mode this phase spent its time removing.

## 24. Technical debt
1. **Session time is measured by presence, at one-minute granularity.** A player connected but
   idle is counted as playing. Sharpening it means a real play-session concept, which is worth
   having when there is a reason to trust the number more than we do now.
2. **The reality-check sweep reads `dueRealityChecks` then checks presence per candidate.**
   Fine at this scale, one round trip per due player; it wants a single query when the player
   base makes it matter.
3. **Entry checks are duplicated** in matchmaking and poker for message quality. ADR-026 says
   why that duplication is acceptable and also why it is the part to watch as games are added.

## 25. Next-phase dependencies
P11 (notifications) has the first real customers for a non-optoutable class: limit reached,
exclusion confirmed, reality check when no socket is open. P12 inherits the review queue this
phase fills, the rule editing it deliberately left to an admin UI, and the three deferrals in
§23. P14 should drive synthetic collusion and multi-accounting scenarios at scale — the
heuristics have thresholds that only real volume can calibrate.
