# Phase 09 — Poker (No-Limit Texas Hold'em, test currency)

## 1. Phase overview
The deepest engineering phase in the roadmap (`docs/MASTER_ROADMAP.md` P9). Poker is not
another game plug-in: it is the first game with **persistent state between matches**
(stacks live at a table, not in a hand), the first with **genuinely hidden information**
(hole cards), and the first whose money model does not fit per-match escrow. Domain spec:
`docs/02-domains/poker.md` — written in P0 and detailed enough to implement from; this plan
records what was built, what deviated, and why.

## 2. Current status
`IMPLEMENTING` — 2026-08-23. Mirrored in `docs/progress.md`.

## 3. Objective
A 2–6 seat NLHE cash table on `TST`: sit down with a buy-in, be dealt in, play hands with
server-authoritative betting rules and timers, win pots decided by a real 7-card evaluator
with correct side pots, and stand up with your stack — with hole cards that provably never
reach another player, live or on reconnect.

## 4. Dependencies
| Dep | Needed for | Verified state |
|---|---|---|
| P6 engine | contract, event log, RNG, recovery | COMPLETE |
| P8 / ADR-023 | `joinMatch` + `guard` (sit-down), `GamePlayer.meta`, `pendingTimer`, `publicView`, replayable clock | COMPLETE |
| **Private-event delivery** | hole cards that survive a resume | **DONE 2026-08-23** (`d6df25d`) — the P9 blocker, cleared before this phase started |
| P7 rails | stake tiers, lobby | COMPLETE |
| P4 wallet | escrow, idempotent settlement, `rake` account type | COMPLETE |
| **OQ-07** | which variant | **DECIDED this phase — NLHE cash** (§9) |

## 5. Preconditions
- Migrations at `0007`; `0008_poker` is this phase's forward step.
- `hidden-info.int-spec.ts` green — the guarantee poker is about to depend on.
- `compliance.real_money_enabled` OFF; rake configured to **0** on `TST`.

## 6. Existing-code analysis
- `EngineService.joinMatch(guard)` fits sit-down; `GamePlayer.meta` carries seat and
  starting stack. Both arrived in P8 for Crash and need no change.
- `RealtimeService.deliver` routes `onlyTo` events to their owner's room. This is what
  makes hole cards safe; without it P9 could not start.
- **Gap found:** settlement has two modes, `pooled` (payouts ≤ escrow) and `house` (house
  balances). Poker fits neither. Stacks persist across hands, so a hand moves **no money at
  all** except rake — the chips are game state backed by a *table*-scoped escrow. Needs a
  third mode and a new account type (§9, §10).
- **Gap found:** `wallet.accounts` keys escrow by `match_id`. A table escrow outlives every
  match at it, so it needs its own key rather than borrowing a match's.

## 7. Scope
1. **OQ-07 decided: NLHE cash tables**, recorded as reversible in `open-questions.md`.
2. **Hand evaluator** — 7-card NLHE, exhaustively tested against known vectors.
3. **Side pots** — `poker.md §6` implemented exactly, with its chip-conservation property
   as a test.
4. **Betting rules** — min bet, min raise increment, the all-in-below-min-raise
   non-reopening rule, uncalled-excess return.
5. **The hand `GameDefinition`** — shuffle from `ctx.random`, four streets, fold/check/
   call/bet/raise/all-in, showdown with reveal order and muck, `playerView` hiding hole
   cards, `publicView`, `pendingTimer` for the turn clock.
6. **Turn timers + timebank** — server-side, auto check-else-fold on expiry.
7. **Tables and seats** — `poker_tables`, `poker_seats`, `poker_hands`; sit, top-up,
   sit-out, stand, all at hand boundaries.
8. **Table-scoped escrow** (ADR-025) — wallet → table on sit, table → wallet on stand,
   table → rake per hand; the `escrow = Σ stacks + pot` invariant reconciled.
9. **The deal loop** — deal the next hand when enough players are ready, button rotation.
10. **Realtime** — table room, private hole-card delivery through the P8/blocker path.
11. **API + contracts + Dart client**; **Flutter** poker table screen (thin, placeholder).
12. **Adversarial tests** — out-of-turn, acting for others, illegal raises, hole-card
    probing on every path including resync.
13. **Docs** — ADR-025, domain doc reconciled to what was built, flow map, progress.

## 8. Out of scope
Per `poker.md §15`: tournaments, other variants, chat, stats/HUD, private tables. Plus:
multi-table *UI* (the model allows it; the client renders one table), ratholing cooldown
(config placeholder, off), timebank refill schedule (fixed initial timebank in v1),
dead-blind rules beyond "wait for the big blind", and P19 visual polish.

## 9. Architecture considerations
**ADR-025 — Table-scoped escrow and table-banked settlement.** A third `GameMeta.banking`
value, `'table'`: the hand posts no payouts at all. Chips move between stacks as game
state; the only ledger movement per hand is rake, from the table's escrow to the house
`rake` account. Money enters and leaves the escrow at sit-down and stand-up, not at hand
boundaries. `GameDefinition.rakeFor(ctx, state)` is how a table-banked game states what
leaves; rule 10 holds — the engine posts it, never the game.

## 10. Database changes
`0008_poker.sql`: `poker.tables`, `poker.seats`, `poker.hands`; `wallet.accounts` gains a
`table_escrow` type and a `table_id` key with its own unique index. Forward-only; rollback
noted in the file.

## 11. Backend changes
- `games/poker/cards.ts` — cards, Fisher–Yates over the audited RNG, and the 7-card evaluator.
- `games/poker/pots.ts` — uncalled excess, side-pot layers, award with rake; conservation asserted.
- `games/poker/betting.ts` — legal actions and bounds; one function serves both validation and the client.
- `games/poker/poker.game.ts` — the hand reducer.
- `games/poker/poker.service.ts` / `poker.repository.ts` — tables, seats, the deal loop.
- `wallet` — `sitDown`, `standUp`, `settleTableHand`, `table_escrow` accounts.
- `engine` — `banking: 'table'` routing, `rakeFor`.

## 12. Flutter changes
`lib/features/poker/` (table list + table, both thin), `playerLabel` in `ui_kit`, lobby
routes round-mode games by game code, `/play/poker` and `/play/poker/:tableId` in the router.

## 13. API changes
Additive under `/v1`: `GET /games/poker/tables`, `GET /games/poker/tables/:id`, and
`POST` for `sit`, `stand`, `top-up`, `sit-out`, `actions`. Contracts in `poker.ts`, Dart
mirror in `api_client`.

## 14. WebSocket changes
`round:table-{tableId}` carries the table's public life. Hole cards travel as private events
on the owner's `user:` room, through the delivery path built before this phase.

## 15. Security considerations (MANDATORY)

### Threats this phase introduces (`docs/04-security/threat-model.md`, `poker.md §16`)

| Threat | Control | Proven by |
|---|---|---|
| Reading another player's hole cards | `playerView` is an allow-list; the deck and other hands never leave it. Private events route to the owner's own room | `poker.game.spec.ts` hiding group; `poker.int-spec.ts` "never puts another player's cards in a view"; `hidden-info.int-spec.ts` resume tests |
| Hole cards via reconnect/resync | Private events are in a one-member room with its own replay buffer | `hidden-info.int-spec.ts` — reconnect and ask from sequence zero |
| Acting for another player | Identity is `action.userId` from the authenticated session; a seat named in the payload is read by nothing | `poker.game.spec.ts` "ignores a seat named in the payload"; `poker.int-spec.ts` out-of-turn |
| Acting out of turn | The reducer checks `toActIndex` before anything else | both suites |
| Illegal raise sizes | `validateRaise` — bounds are public, so the refusal names them | `betting` tests; `poker.int-spec.ts` |
| Retrieving committed chips by leaving | Standing mid-hand only marks the seat; the stack pays out at hand end | `poker.int-spec.ts` "cannot retrieve chips already committed" |
| Two seats for one player at a table | Unique `(table_id, user_id)`; checked under the table lock | `poker.int-spec.ts` "refuses a second seat" |
| Chips created or destroyed by pot maths | Conservation asserted inside `settleShowdown`; a hand that cannot conserve refuses to settle | `pots.spec.ts` property test + the assertion's own test |
| Stacks not backed by money | Table escrow == Σ stacks, reconciled after every hand | `poker.int-spec.ts` escrow-invariant suite |

**Threat-model delta:** one new room shape (`round:table-*`, public data only), one new
account type (`table_escrow`), one new settlement path. No new trust boundary, no new
external dependency, no new PII — the public seat list deliberately shows a truncated id
rather than a display name (rule 15).

### Checklist (`docs/04-security/security-checklist.md`)

**A. Every phase** — [x] authz on all six new endpoints (global guard; actor from the token,
never the body; negative cases tested). [x] Input validation via zod plus the reducer's own
rules; malformed and illegal inputs rejected with the standard envelope. [x] Rate limits:
write class for actions, read class for table reads — no new class. [x] Audit: sit-down,
cash-out and rake all post through `LedgerService`, which audits; hand outcomes are in the
append-only event log. [x] No PII in logs or views. [x] No new secrets. [x] Errors carry no
internals — a rejected raise names the legal bound, which is public. [x] No new
dependencies. [x] Threat delta above. [x] All green in `verify:all`.

**B. Financial** — [x] Idempotency: seat sessions key buy-in and cash-out; settlement keys
on match id. [x] Concurrency: seat allocation, the dealt set and the button all under the
table row lock; the escrow invariant is checked after each hand. [x] Ledger invariants
unchanged and still enforced by the database. [x] Reconciliation: the run is green with
table escrows present. [x] Four-eyes: N/A — no new adjustment path. [x] Rounding: the odd
chip of a split has a named owner (first left of the button) rather than a sort order, and
rake rounds down per pot with the remainder placed so the total is exact.

**C. Game** — [x] Conformance green, including two new checks a table-banked game must
pass. [x] Information hiding tested at unit, integration and protocol level, **including
resync** — the item P8 could only partly close. [x] RNG: the deck is a Fisher–Yates over
`ctx.random`, every index an audited draw; the reducer is handed a throwing `random` in
tests so an unaudited draw fails the suite. [x] Timers server-side; the client's countdown
is cosmetic. [x] Kill-switch drain tested. [x] Timing/shape: views have the same shape
whatever a player holds — `cards` is present and null rather than absent.

**D. Client** — [x] No hardcoded styles (executable test). [ ] APK string-dump and
[ ] obfuscation: **cannot run — no Android SDK in this environment** (carried from P2 §23);
open, not waived. [x] Hardening signals: N/A, no new sources. [x] Client validates for UX
only — every bound has a server-side counterpart test, and the widget tests assert the
screen shows the server's refusal rather than pre-empting it.

## 16. Edge cases
Heads-up blind/act order; the big blind's option when everyone limps; all-in below a full
raise not reopening; short stack all-in below the minimum; uncalled excess returned before
pots exist; folded players' chips in the layers but never eligible; everyone all-in running
the board out; a hand ending with no showdown revealing nothing; a player busting to zero;
standing up mid-hand; a hand voided mid-street restoring the stacks it started with; a
restart mid-hand replaying the same cards; the kill-switch pulled with a hand in flight.
All covered by tests named after them.

## 17. Testing strategy
Unit for everything pure (evaluator cross-validated against a brute-force reference over
thousands of random hands; pots with a chip-conservation property; the reducer driven
through real hands). Integration for everything with money or a database. Protocol-level
adversarial tests for hidden information. Existing suites stay green.

## 18. Implementation plan
Done in dependency order: blocker → evaluator → pots → betting → reducer → contract/engine/
wallet plumbing → tables and the deal loop → API → Flutter → docs.

## 19. Rollback / recovery
Kill: `game.poker.enabled` false — the hand in flight finishes and pays out, no further hand
is dealt, no new seats. Migration rollback in the file header. Not rollbackable: hands
already played, which are event-log history; a correction would be a reversal.

## 20. Acceptance criteria
1. A player can sit with a buy-in, be dealt in, act, and stand up with their stack. ✅
2. Table escrow equals the sum of the stacks after every hand. ✅
3. A hand moves no money except rake (zero on `TST`). ✅
4. Hole cards never reach another player — live, on resync, or in the public view. ✅
5. Illegal actions are refused with the legal bounds and change nothing. ✅
6. A hand interrupted by a restart replays with the same cards and finishes. ✅
7. A voided hand restores the stacks it started with. ✅
8. The kill-switch drains. ✅
9. `pnpm verify:all` green, no skips. ✅

## 21. Definition of done
Met — see §20 and §22.

## 22. Completion report

**Delivered: all thirteen scope items in §7.** Nothing was dropped. What was deliberately
left out is in §8 and §23, and it is the same list the domain doc already deferred.

### Test evidence

| Lane | Before P9 | After |
|---|---|---|
| API unit | 120 | **203** |
| API integration | 130 | **158** |
| Flutter app | 26 | **32** |
| ui_kit | 26 | **28** |
| api_client (dart) | 28 | 28 |

`pnpm verify:all`: all lanes green, no skipped tests. The integration suite was run
repeatedly rather than once — 3 clean full runs plus 6 clean runs of the Crash suite after
the flake fix below.

The evaluator is the piece it would be easiest to be quietly wrong about, so it is not
tested by examples alone: it is **cross-validated against an independently written
brute-force reference** that ranks all 21 five-card subsets, over thousands of random hands
per run, on category, ordering and ties. The two share no code. Pot construction is likewise
backed by a property — every committed chip is awarded, returned or raked — asserted both in
a randomised test and, at runtime, inside `settleShowdown` itself.

### What running the code found

1. **A folded player out-committing everyone live silently lost chips.** Unreachable in real
   play, which is exactly why it would have gone unnoticed. Rather than make the pot builder
   redistribute its way out of an impossible state, `settleShowdown` now asserts
   conservation and throws — leaving the hand unsettled for a human, which is what the
   wallet already does when settlement does not match escrow. The alternative was chips
   evaporating into a rounding-shaped hole.
2. **The odd chip of a split pot went to the wrong player.** The rule is "first player left
   of the button", and the implementation read a seat's `order` field — which is whatever
   order the caller supplied. Now computed from the button's position inside the reducer, so
   a caller that orders its seats differently cannot move the money.
3. **`playerLabel('bob')` crashed the table screen.** `substring(0, 4)` on a
   three-character id throws, and a display helper took the whole screen down. Found by a
   widget test using short fixture ids; fixed as a shared `ui_kit` helper — which is also
   where the rule-15 reason for truncating belongs.
4. **The house-account upsert broke when the escrow index changed.** The migration narrowed
   `accounts_house_uq` to exclude table escrows, and `ensureHouseAccount`'s `ON CONFLICT`
   predicate no longer matched it. Caught immediately by the integration suite, but worth
   noting: a partial-index predicate is duplicated between schema and query, and nothing
   type-checks that pair.
5. **A flaky Crash test asserting a state the game may skip.** It waited to observe a round
   `in_progress`, and about three rounds in a hundred crash at 1.00× — a flight of zero
   milliseconds. The round was behaving correctly; the test was asserting an intermediate
   state it was not entitled to. Now it waits for the round to have *run* and asserts on
   what it became. Same class as the P8 matchmaking flake, and fixed the same way.

### Deviations from the plan

- **`poker.md §2` said a bet is a `reduce` action and seats are reserved through
  matchmaking.** Neither is how it was built. A hand takes no buy-in at all — the chips are
  already at the table — so seating is `sit`/`stand` against the table, and matchmaking is
  not involved. The domain doc has been reconciled rather than left to disagree.
- **Ratholing, timebank refill and dead-blind rules** are configuration placeholders rather
  than implemented policies (§23). They are fairness refinements, not correctness, and each
  one deserves a product decision rather than my guess.
- **The button rotates by seat, not by "who was dealt in last hand".** Simpler, and correct
  for a cash table where the population changes between hands; a player who sits down does
  not skip the blinds.

### Performance notes

Not load-tested — that is P14, and `poker.md §18` names the target (a six-player hand
surviving a mid-hand server kill on real devices). What is known: a hand is one match, one
settlement transaction at most (zero when rake is zero), and one Redis lease renewal per
4 s per table. The evaluator runs once per contender at showdown. The heaviest thing in the
unit suite is the evaluator cross-validation, deliberately.

## 23. Known limitations

- **No ratholing cooldown.** A player can leave a table having lost most of a stack and
  re-sit at the minimum. Config placeholder only.
- **No timebank refill.** Each hand starts with the configured timebank; it does not grow
  back over an orbit as `poker.md §8` describes.
- **No dead blinds or big-blind-wait for a returning player.** Someone who sits out and
  comes back is dealt in on the next hand wherever the button happens to be, so blind
  dodging is possible at the margins. Named in `poker.md §9`; not built.
- **One table per stake tier.** The model supports many (tables are rows); nothing creates
  a second one yet. Table creation and closing are P12 admin concerns.
- **No mid-hand disconnect grace period.** A disconnected player is treated exactly like a
  slow one: the turn clock runs, the timebank drains, then the server checks or folds. That
  is the safe behaviour for everyone else at the table, but it is stricter than §9's design.
- **Multi-table is server-side only.** A player may hold four seats; the client renders one
  table at a time with no switcher.
- **Muck is automatic.** Losing hands at showdown are not shown, and there is no explicit
  `show`/`muck` action for a player who wants to reveal.
- **The Android build is still unverified** (no Android SDK here, from P2 §23).

## 24. Technical debt

| # | Debt | Impact | Payoff |
|---|---|---|---|
| 1 | Partial-index predicates duplicated between migration and `ON CONFLICT` query | A schema change can silently break an upsert; caught only by tests | P12, when admin work touches accounts |
| 2 | No reconciliation check for the table-escrow invariant (it is asserted in tests, not by the scheduled job) | Drift between stacks and escrow would be found by a test run, not by the platform | **P10** — it is a money invariant and belongs in the sweep |
| 3 | Ratholing, timebank refill, dead blinds (§23) | Fairness gaps at the margins | P10 with the rest of the fairness/risk work |
| 4 | Disconnect grace period | Stricter than designed; a brief drop costs a fold | P10 |
| 5 | Nothing closes an abandoned table, so its escrow stays open | A table with no players holds a zero balance but stays `open` | P12 |
| 6 | Conformance does not check that a `rounds` game defines `pendingTimer` (carried from P8) | A game can forget an optional hook and fail at runtime | P10 |
| 7 | Seed chaining for Crash provable fairness (carried from P8) | The series is not pre-committed, only each round | P10/P14 |
| 8 | `match:found` still shows a snackbar rather than navigating (carried from P7) | Nothing is broken: neither shipped game emits it | P10, or delete it |
| 9 | Startup recovery replays serially (carried from P6) | Slow start with a large backlog | P14 |
| 10 | `game.formations` written but never read (carried from P7) | None; evidence awaiting a reader | P12 |
| 11 | Multi-table has no client switcher | Four seats are reachable only one screen at a time | P19 |

## 25. Next-phase dependencies

**P10 (risk & responsible gaming)** can now consume what `poker.md §14` promised: complete
hand histories in the event log including mucked cards and folds, seating patterns from
`poker.seats`, and per-hand chip flow from `poker.hands`. Poker takes no detection
decisions; it will honour risk actions (freeze → sit out, then stand at the hand boundary).
Debt #2 is P10's to close — the table-escrow invariant is a money invariant and belongs in
the reconciliation sweep, not only in a test.

**P12 (admin)** gets table creation, closing and live view; the data model already supports
several tables per tier.

**P14 (hardening & load)** gets the target `poker.md §18` names: a six-player hand surviving
a mid-hand server kill, and settlement-burst load across tables.

**Then STOP** — P9 is complete; P10 is not started.
