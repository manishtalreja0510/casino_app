# Phase 08 — Casino game #1: Crash (test currency)

## 1. Phase overview
The first **shipped** game goes through the `GameDefinition` contract built in P6, on the
matchmaking/lobby rails built in P7 and the realtime rails built in P5. Roadmap entry:
`docs/MASTER_ROADMAP.md` § "P8 — Casino game #1 (test currency)". Domain doc:
`docs/02-domains/casino-game.md` (written game-agnostic, with a Crash-shaped worked
example in §5 — this phase makes that example real). The point of the phase is not the
game: it is proving the platform can host a game as a **plug-in** without reshaping
itself, and finding out honestly where it cannot.

## 2. Current status
`COMPLETE` — 2026-08-23. Mirrored in `docs/progress.md`.

## 3. Objective
`crash` is a real, playable, house-banked, provably-fair round game: a betting window
players opt into, a server-authoritative multiplier curve, cash-outs validated against a
server clock the client cannot influence, and settlement that pays winners from escrow and
the house float — all on `TST`, all idempotent, all replayable, all behind a per-game
kill-switch that drains rather than cuts.

## 4. Dependencies
| Dep | Needed for | Verified state |
|---|---|---|
| P6 game engine | contract, event log, RNG, recovery, settlement | COMPLETE — `engine.int-spec.ts` green before starting |
| P7 matchmaking/lobby | stake tiers, lobby surface, `game.stake_tiers` | COMPLETE — `matchmaking.int-spec.ts` green |
| P5 realtime | rooms, sequencing, resume, server timers | COMPLETE — `realtime.int-spec.ts` green |
| P4 wallet | escrow, idempotent settlement, `house_main` account type | COMPLETE — `ledger.int-spec.ts` green |
| **OQ-05** | which casino game ships first | **DECIDED this phase — Crash** (see §9) |

## 5. Preconditions
- Migrations at `0006`; `0007_crash` is this phase's forward step.
- `game.coin-duel.enabled` present; `game.crash.enabled` added by `0007`.
- `compliance.real_money_enabled` OFF (rule 11) — this phase never touches that gate.
- `pnpm verify:all` green on `d65836b` before any change.

## 6. Existing-code analysis
Verified by reading and running, not assumed:

- `EngineService.createMatch` charges every buy-in in **one** transaction (P7's headline
  guarantee) and takes a **fixed roster and a single stake for everyone**. Crash needs the
  opposite shape: an open roster, per-player bet sizes, and *independent* buy-ins — one
  player's bounced bet must not cancel the round for everyone else. → §9 / ADR-023.
- `WalletService.settle` **rejects** `Σpayouts > escrow`. That is correct for a pooled
  game and fatal for a house-banked one, where a 5× cash-out is paid by the house. → §9 /
  ADR-024.
- **Drift found (real bug):** `GameContext.now` is documented as "deterministic during
  replay — never wall-clock time inside a reducer", but `EngineService.context` passes
  `() => Date.now()`. Nothing has noticed because `coin-duel` never calls `now()`. Crash's
  entire outcome is a function of elapsed time, so replay would produce a different match
  than the one played. Fixed here (§11), not filed.
- `RecoveryService.recover` resumes a match but **re-arms no timer**: a `coin-duel` turn
  deadline survived only because the match was still driven by player actions. A resumed
  Crash round would hang in flight forever. Fixed here (§11).
- `runConformance` asserts `Σpayouts ≤ pot`, which no house-banked game can satisfy, and
  hands every step the same `now()`. Both made banking-aware / clock-aware (§17).
- `MatchmakingService.sweep()` exists but nothing calls it (debt from P7). Paid here.
- Flutter lobby polls; `lobby:{gameCode}` is broadcast but nothing subscribes (debt from
  P7). Paid here.

## 7. Scope
1. **OQ-05 decided: Crash.** Recorded in `open-questions.md` with the reasoning and the
   cost of changing our mind.
2. **Open-roster matches** in the engine: `createOpenMatch` / `joinMatch` / `startMatch`,
   with per-player stakes and per-player atomic buy-in. `createMatch` unchanged.
3. **House-banked settlement** in the wallet: `settleHouseBanked`, with the `house_main`
   leg computed as the round's net, and the same idempotency-first discipline as `settle`.
4. **Deterministic clock**: recorded `now()` reads, replayed like RNG draws.
5. **`crash` game module**: pure reducer, integer-only multiplier curve, commit–reveal
   crash point with a disclosed house edge, manual and auto cash-out.
6. **Round orchestration**: per-tier round loop (betting window → flight → crash →
   settle → next), single-writer across instances via a Redis leader lease, per-game
   kill-switch drain.
7. **Exposure control**: per-bet min/max, per-round total stake cap, max house exposure —
   all config, all enforced server-side at bet time.
8. **Public round room** `round:{tierId}` with a `publicView` contract hook, so spectators
   and betters see the same round without anyone seeing the unrevealed seed.
9. **REST + WS surface**: round state, place bet, cash out; contracts + Dart client.
10. **Flutter**: crash screen (thin), round-room subscription, bet panel, multiplier
    display, outcome strip; ui_kit components; router + lobby routing for round games.
11. **Debt paid**: scheduled formation sweeper; Flutter lobby socket subscription.
12. **Docs**: game rules + fairness note (`docs/02-domains/crash-game-rules.md`),
    ADR-023/024, flow map, progress.

## 8. Out of scope
- Visual polish, sound, animation choreography (P19) — placeholder look, token-styled.
- Promotions, bonuses, leaderboards, chat.
- A verifier UI for provable fairness (the data is exposed; the UI is P19+).
- Bet cancellation during the betting window (a bet is committed when escrowed; §16).
- Multi-round seed chaining (`seed_n = H(seed_{n+1})`) — single-round commit only (§23).
- `match:found` navigation (P7 debt): Crash is round-based and never emits it; it stays
  P9's to pay, when a match screen exists to navigate to.

## 9. Architecture considerations
Two genuine architectural changes, each with an ADR (rule 19):

- **ADR-023 — Open-roster, round-based matches.** The engine gained a second admission
  model. Matchmade games keep all-or-nothing formation; round games open a match, take
  independent buy-ins during a window, and start with whoever paid. This is the
  "degenerate queue" `casino-game.md §2` predicted, made concrete. Additive contract
  fields: `GameMeta.mode`, `GameMeta.banking`, `GamePlayer.meta`, `GameDefinition.publicView`,
  `GameDefinition.pendingTimer`.
- **ADR-024 — House-banked settlement.** Wins beyond escrow are paid by `house_main`;
  losses land there. Exposure is capped at bet time so the house's worst case on a round
  is a known number before the round starts.

Module boundaries hold: the `crash` module owns no tables of its own, talks to the engine
and never to the ledger (rule 10), and the engine still never learns anything
Crash-specific — `banking`/`mode` are declarations, not branches on a game code.

## 10. Database changes
`0007_crash.sql` (forward-only; rollback noted in the file):
- `game.match_players.meta jsonb NOT NULL DEFAULT '{}'` — per-player round data. Crash
  stores the auto-cash-out target here; poker will store sit-out state (P9).
- `game.stake_tiers.config jsonb NOT NULL DEFAULT '{}'` — per-tier game config (bet
  bounds, exposure caps, timings, house edge).
- Three `crash` tiers + the `game.crash.enabled` flag (ON: it is a `TST` game behind the
  compliance gate).
No backfill, no rewrite, no lock of consequence — both columns have defaults and the
tables are small.

## 11. Backend changes
- `game-engine/clock.service.ts` — recording/replaying `now()`. Stored as `__clock` beside
  `__draws`; `replayAndVerify` consumes both.
- `engine.service.ts` — `createOpenMatch`, `joinMatch`, `startMatch`; `pendingTimer`
  arming after start and after recovery; banking-aware settlement routing; an in-process
  `onMatchChanged` listener so a round owner can publish public state.
- `recovery.service.ts` — re-arms deadlines on resume.
- `wallet.service.ts` — `settleHouseBanked`.
- `games/crash/` — `crash.game.ts` (pure), `crash.config.ts` (zod), `crash.service.ts`
  (round loop, bets, exposure), `round-leader.service.ts` (Redis lease),
  `crash.controller.ts`, `crash.module.ts`.
- `matchmaking` — refuses queueing for round-mode games; exposes `mode` in the lobby;
  registers the sweeper job.

## 12. Flutter changes
`lib/features/crash/` (thin shell + providers), `ui_kit` gains `AppMultiplierDisplay` and
`AppOutcomeStrip` (token-styled, placeholder look), lobby subscribes to `lobby:{gameCode}`
and routes round-mode games to `/play/crash/:tierId`. Flow map updated in the same change.

## 13. API changes
Additive under `/v1` (rule 23): `GET /games/crash/rounds/:tierId`,
`POST /games/crash/rounds/:tierId/bets`, `POST /games/crash/rounds/:matchId/cash-out`.
Contracts: `crash.ts` in `packages/contracts`; Dart mirror in `api_client`.

## 14. WebSocket changes
New room shape `round:{tierId}` (public to authenticated players — it carries no
player-private data). Events: `round:open`, `round:bet`, `round:flying`, `round:crashed`.
Per-player state still arrives on `user:{id}` as `game:state`, unchanged.

## 15. Security considerations (MANDATORY)

### Threats this phase introduces or touches (`docs/04-security/threat-model.md`)

| Threat | Control | Where it is proven |
|---|---|---|
| Client forges its multiplier to cash out high | A cash-out request has **no multiplier field**; the server prices it from its own recorded clock through a pure function | `crash.game.spec.ts` "prices a cash-out from the server clock" (sends a fake multiplier; it is ignored); `crash_screen_test.dart` "sends the cash-out with no multiplier attached" |
| Late cash-out wins because the crash timer fired late | The reducer refuses on `m ≥ crashPoint`, independent of any timer | `crash.int-spec.ts` "refuses a cash-out once the curve passed the crash point, timer or no timer" — the test **cancels the timer** to create the window |
| Seed or crash point leaks before the reveal | Both live in match config/state, which reach clients only through `playerView`/`publicView` | `crash.game.spec.ts` "information hiding" group; `crash.int-spec.ts` "never puts the seed or the crash point in a view before the round ends" |
| House drained by unbounded exposure | `meta.maxPayoutX100` declared, per-tier stake and exposure caps enforced **inside the join transaction** | `crash.int-spec.ts` stake-cap and exposure-limit tests; conformance rejects a house-banked game with no declared ceiling |
| Bet charged twice on a retry | Buy-in idempotent per `(match, user)`, plus a roster uniqueness check | `crash.int-spec.ts` "charges a bet exactly once when it is retried" |
| One player's failure cancels everyone's round | Per-player buy-in transactions (ADR-023) | `crash.int-spec.ts` "does not let one player's bounced bet cancel everyone else's" |
| Spectator scrapes another player's private state | `round:` rooms carry `publicView` only; `canJoin` still refuses another player's `user:` room | `realtime.gateway.ts` `canJoin`; `crash.game.spec.ts` "gives a spectator no per-player private view at all" |
| Settlement replayed after a crash pays twice | Idempotency checked **before** validation, keyed by match id | `crash.int-spec.ts` "pays once, however many times settlement is retried" |

**Threat-model delta:** one new public room shape (`round:{tierId}`) carrying only
`publicView` output, and one new money path (`settleHouseBanked`) inside the existing
engine→wallet boundary. No new trust boundary, no new external dependency, no new PII.

### Checklist (`docs/04-security/security-checklist.md`)

**A. Every phase**
- [x] **Authz deny-by-default** — the three new endpoints sit behind the global access-token guard; the bettor is `request.auth.userId`, never a body field. Cash-out on a match the caller is not in is refused (`crash.int-spec.ts` "refuses a cash-out from someone who did not bet").
- [x] **Input validation from contracts** — zod at the controller (`placeBetSchema`), tier bounds and auto-cash-out range in the service, and the reducer rejecting anything invalid. Negative cases tested ("refuses a bet outside the tier bounds", including a nonsense auto-cash-out).
- [x] **Rate limits considered** — bet and cash-out inherit the platform limiter's write class; no new class. Round reads are read-class. Recorded here rather than left implicit.
- [x] **Audit events** — `game.settled` now carries `banking` and `houseNet`; buy-ins and settlements audit through `LedgerService.post` as before. Round opens are deliberately **not** audited: no money moves.
- [x] **No PII/secrets in logs** — the seed is never logged, before or after the reveal. Log statements carry match ids, tier ids and amounts. The public bet board shows a truncated user id, not a display name.
- [x] **No new secrets outside the secret manager** — the round seed is generated per round, lives in the database, and is published deliberately at the end. It is an outcome commitment, not a credential; nothing was added to the secret inventory. gitleaks green.
- [x] **Error responses leak no internals** — new failures are `DomainError`s with player-facing messages and the standard envelope.
- [x] **Dependencies scanned** — no new dependencies in this phase.
- [x] **Threat-model delta reviewed** — table above.
- [x] **All of the above tested and green** — `pnpm verify:all`, §22.

**B. Financial-touching**
- [x] **Idempotency tests** — settlement replay, and a repeated bet.
- [x] **Concurrency/race tests** — the exposure and stake caps are enforced by a `guard` **inside** the join transaction precisely because checking them beforehand is a race; P4's parallel-spend storm still green.
- [x] **Ledger invariant tests** — reconciliation run twice in this suite, including after the house float has been driven negative; sum-zero, append-only and non-negative-user-balance constraints unchanged and still enforced by the database.
- [x] **Reconciliation coverage** — house-banked settlement uses the same escrow accounts the escrow-vs-matches check already walks; escrow-zero asserted per round.
- [x] **Four-eyes where required** — N/A: no new adjustment or gate path. The compliance gate is untouched by this phase.
- [x] **Rounding rules explicit** — **found and fixed while running this checklist.** The payout rounded *down*, which favours the house; policy (`financial-security.md §11`) is that player credit rounds **up**. Now `ceil`, documented in the published rules, and pinned by a property test asserting the payout is never below `stake × multiplier` and never more than one minor unit above it.

**C. Game-touching**
- [x] **Conformance suite green** — `crash` runs the same suite as the reference game, extended for banking-aware settlement and a scripted clock. A deliberately unbounded variant is asserted to fail it.
- [x] **Information-hiding tests** — unit, conformance and integration, on `playerView` and `publicView`. **Partial on resync:** the room-wide replay buffer carried from P5 is not a leak for Crash (its room is public by construction) but is not *tested* as safe for private rooms — that debt is P9's blocker and is recorded as such, not quietly checked off here.
- [x] **RNG draws audited** — Crash draws no RNG at all: the outcome is derived from a committed seed, which is a stronger claim than an audited draw (it is checkable by the player). The seed is generated by `RngService`'s CSPRNG-backed commitment helper. `crash.game.spec.ts` gives the reducer a `random` that throws, so an accidental draw would fail the suite.
- [x] **Timers server-side** — the crash deadline is a server timer, and the *authority* is a pure comparison that does not depend on it. Proven by cancelling the timer and showing the refusal still happens.
- [x] **Kill-switch drain tested** — "drains: the open round finishes, no new bets are taken, no new round opens", with escrow asserted intact mid-drain and zero after.
- [x] **Timing/shape review** — the only response that could branch on hidden information is the round view, and its shape is identical in every phase (the secret fields are present and `null` before the reveal rather than absent).

**D. Client-touching**
- [x] **No hardcoded styles** — the executable rule-25 test covers the new screen; two new `ui_kit` components are token-styled.
- [ ] **No secrets in binary** — **cannot be run: no Android SDK in this environment** (carried from P2 §23). The client gains no new configuration in this phase and holds no seed; the string-dump check runs when a build environment exists.
- [ ] **Obfuscation on release** — same environment limitation; unchanged by this phase.
- [x] **Hardening signals wired** — N/A for this phase: no new signal sources. Recorded rather than silently skipped.
- [x] **Client validates for UX only** — digits-only inputs and disabled buttons are UX; every bound has a server-side counterpart test, and the widget tests assert the client shows the *server's* refusal rather than pre-empting it.

## 16. Edge cases
- Betting window closes with **no** bets → round voided (nothing to refund), next round
  opens. Voided-with-zero-escrow settles without a ledger transaction (P7's zero-stake path).
- A bet arriving after the window closed → refused; money never moved.
- Insufficient funds mid-window → that player alone is refused; the round is unaffected.
- Two cash-outs from one player → the second is rejected by the reducer.
- Cash-out at exactly the crash tick → losing ride (`m >= crashPoint` ends the round).
- Instant bust (crash point 1.00×) → nobody can cash out; every stake is a house win.
- Process restart mid-flight → replay verifies, `pendingTimer` re-arms the remaining
  flight time, the round finishes. If replay fails, the round is voided and every bet
  refunded.
- Leader lease lost mid-round → the new leader does not touch a round it did not open; the
  round finishes on the engine's own timer and the next round opens under the new leader.
- Kill-switch pulled mid-round → the round finishes; no new round opens (drain, rule 16).
- Clock skew between instances → irrelevant to money: the round's clock reads are recorded
  by whichever instance served them and replayed from the log.

## 17. Testing strategy
- **Unit** (`crash.game.spec.ts`): curve monotonicity and integer-exactness; crash-point
  distribution bounds and house-edge arithmetic; cash-out pricing at, before and after the
  crash tick; auto-cash-out; payout table exactness against the RNG/seed stream; secret
  hiding in `playerView`.
- **Conformance** (`conformance.spec.ts`): `crash` runs the same suite as `coin-duel`,
  with banking-aware settlement checks and a scripted clock.
- **Integration** (`crash.int-spec.ts`): a full round end-to-end on real PostgreSQL and
  Redis — bets escrowed, flight, crash, house-banked settlement, escrow zeroed, balances
  exact; idempotent re-settlement; late cash-out rejected; exposure cap enforced; empty
  round voided; kill-switch drain.
- **Existing suites stay green**: ledger properties, engine, matchmaking, realtime, auth.
- **Flutter**: crash screen renders each phase from server state; no hardcoded styles.

## 18. Implementation plan
1. Contract + conformance changes (additive, nothing else breaks).
2. Clock determinism + recovery re-arm (engine correctness, independent of Crash).
3. Wallet house-banked settlement + its tests.
4. Engine open-roster admission + its tests.
5. `crash.game.ts` pure + unit tests (no I/O, fastest feedback).
6. Round orchestration + integration tests.
7. API + contracts + Dart client.
8. Flutter screen + ui_kit + tests.
9. Debt: sweeper job, lobby subscription.
10. Docs, security checklist, progress.
Flag-gating: `game.crash.enabled` gates the whole game from step 6 onward, so every
intermediate state ships dark.

## 19. Rollback / recovery
Kill: set `game.crash.enabled` false — the current round drains, no round opens, the lobby
stops offering it. Migration rollback: drop the two columns and the tier/flag rows
(`0007` header). Not rollbackable: rounds already settled — they are ledger history, and
the correction path is a reversal, never an edit (rule 5).

## 20. Acceptance criteria
1. A player with `TST` can open the lobby, enter a Crash tier, place a bet in the window,
   watch the multiplier, cash out, and see their balance change by exactly
   `floor(stake × multiplier / 100) − stake`.
2. A player who does not cash out before the crash loses exactly their stake, to
   `house_main`.
3. Round escrow is zero after settlement, every time.
4. Re-running settlement for a round pays nothing further.
5. A cash-out submitted after the crash point is refused, whether or not the crash timer
   has fired.
6. `playerView` and `publicView` never contain the server seed or crash point before the
   round crashes.
7. Revealing: after the round, `sha256(serverSeed) == commitment` published before betting,
   and the published function recomputes the same crash point.
8. Pulling the kill-switch finishes the in-flight round and opens no further ones.
9. A killed process mid-flight resumes the round and settles it correctly.
10. `pnpm verify:all` green, no skipped tests.

## 21. Definition of done
See §20 + `docs/phases/PHASE_TEMPLATE.md §21`. All met — §22.

## 22. Completion report

**Delivered, against §7's twelve scope items: all twelve.** Nothing was dropped, and the
one thing that grew — the security checklist turning up a rounding-policy violation — is
recorded below rather than quietly fixed.

### Test evidence

| Lane | Before P8 | After |
|---|---|---|
| API unit | 82 | **120** |
| Contracts unit | 11 | 11 |
| API integration | 106 | **130** |
| Flutter app | 18 | **26** |
| ui_kit | 21 | **26** |
| api_client (dart) | 13 | **28** |

`pnpm verify:all`: **all lanes green** — lint, typecheck, unit, build, migrations,
integration, flutter analyze, flutter test (app), flutter test (ui_kit), dart test
(api_client), secret scan. No skipped tests.

The integration suite was also run repeatedly rather than once, which is how the last two
defects surfaced. Two **pre-existing flaky tests** were fixed by making them assert the
property that matters rather than an incidental one:

- P7's four-way matchmaking race counted the match ids that `joinQueue` *returned*. Under a
  real race one player's attempt can form a match it is not in, so a match exists that no
  caller was told about — the test failed roughly one run in three while the system was
  behaving correctly. It now reads the seating from the database.
- Several Crash assertions read the match status immediately after firing the crash by
  hand, while the round's own armed timer could be settling it concurrently. They now wait
  for the outcome instead of assuming whose call stack produced it.

### What running the code found (as opposed to reading it)

Five real defects, four of them pre-existing and none of them visible to a type checker:

1. **`GameContext.now()` was not replayable.** Documented as "deterministic during replay",
   implemented as `Date.now()`. Invisible for two phases because the reference game never
   asks the time; fatal for Crash, whose entire outcome is elapsed time — replaying a
   finished round would have priced every cash-out at whatever moment the replay ran, and
   a dispute would have been unanswerable. Fixed by recording clock reads with the event
   that consumed them, exactly as RNG draws already were.
2. **Recovery re-armed no deadline.** `RecoveryService` resumed matches and left them with
   no timer. A `coin-duel` turn survives that (the next player action re-arms it); a
   resumed Crash round would have sat in flight forever with stakes in escrow, waiting for
   a crash that could no longer happen. Fixed with `pendingTimer`, tested by resuming a
   round and finishing it.
3. **Every POST and DELETE from the Flutter client went nowhere.** The URI was built from a
   string in which the interpolation markers were backslash-escaped, so it parsed the
   *source text* rather than the base URL and path — a shell-escaping artifact that is
   valid Dart, compiles silently and passes
   `dart analyze`. Sign-in, registration, funding, queue-joining and ticket requests all
   built a nonsense relative URI. It survived P3 through P7 because the API's suites test
   the *server* and no Flutter test had ever made the client POST. Found the moment a
   widget test did. Fixed, with a regression test per verb asserting the absolute URL.
4. **The conformance suite could not express a house-banked game.** It asserted
   `Σpayouts ≤ pot` unconditionally — correct for pooled games, impossible for any game
   where the house is the counterparty. Now banking-aware, and it *fails* a house-banked
   game that will not declare its worst case.
5. **Payouts rounded the wrong way.** Found by actually running the security checklist
   rather than ticking it: `floor` favours the house, and `financial-security.md §11` says
   player credit rounds up. One minor unit per cash-out, and entirely the point — a written
   rule that always resolves the same way is what makes a rounding dispute answerable.
6. **The audit chain verifier reported "valid" for a chain it had only partly read.**
   `verify()` walks a bounded window (10,000 rows) and returned `valid: true` on filling
   it. Nothing in production calls it yet, so it had never mattered — but the first
   scheduled run on a real database would have reported an intact chain while never
   looking at anything recent, and tampering with a recent row would have gone undetected.
   That is the exact failure hash-chaining exists to prevent. `valid` now means "nothing I
   read was wrong" and a separate `complete` means "I read all of it"; `verifyAll()` pages
   through, linking each window to the next so the boundary is checked like any other
   link. A caller must require both.

**And one incident of my own making, worth recording rather than quietly cleaning up.**
The scheduled formation sweep this phase added (P7 debt) runs in *every* instance,
including the ones integration tests boot. The audit suite's tamper test assumed it was the
only writer: it tampered with `ORDER BY seq DESC LIMIT 1` and "restored" it to a payload it
had invented. With a background writer in play it sometimes restored **someone else's row**
— and when its assertion failed it threw before restoring at all. Five rows of this
repository's local audit chain were left broken that way before I noticed. Fixed in three
places: the test now identifies its own row by id, captures the original bytes, and
restores them in a `finally`; scheduled work became an explicit instance role
(`SCHEDULED_WORK_ENABLED`) that test processes decline; and the five corrupted dev rows
were repaired to their original values with the break re-verified as closed. A
tamper-detection test that tampers with the audit log is worth naming out loud.

### Deviations from the plan

- **`SCHEDULED_WORK_ENABLED` was not in the plan.** Booting the whole app in a test process
  meant every integration suite quietly acquired two background writers — the round loop
  opening real rounds, and the formation sweep forming real matches — both moving test
  credits and writing audit rows between other suites' arrange and assert steps. Rather
  than a test-only hack, scheduled work became an explicit instance **role**, which is also
  the honest deployment model: an instance can serve the whole API without taking it on.
- **`casino-game.md §2` predicted that a bet would be a `reduce` action.** It is not: the
  betting window is the match's `created` status and a bet is `joinMatch`. The doc was
  corrected to what was built, with the reasoning, because the built version is cleaner —
  the reducer never has to model money that might not be there yet.
- **The client draws the curve locally.** Rule 12 forbids duplicating business logic into
  Flutter, and a crash client that renders a rising number is unavoidably rendering the
  curve. The resolution: the server sends the curve's *parameters* (`tickMs`,
  `growthPerMille`), the client draws from them, every server message overrides what was
  drawn, and no payout is ever computed client-side. Called out here because it is a
  judgement call at the edge of a rule, not an oversight.

### Performance notes

Not load-tested — that is P14. What is known: a round is one match, one settlement
transaction, and one Redis lease renewal per 5 s per tier; the multiplier is not broadcast
at all, so a room's event rate is four events per round plus one per bet and cash-out. The
curve loop is bounded by the multiplier cap (463 iterations at 100×) and runs per
cash-out, not per tick.

## 23. Known limitations

- **The seed is committed per round, not chained.** A chain (`seed_n = H(seed_{n+1})`)
  would prove the whole *series* was fixed in advance, not just each round. Worth doing;
  not worth blocking the first game on. `crash-game-rules.md §5` states plainly what
  today's proof does and does not cover.
- **No bet cancellation** during the betting window. The stake is escrowed when the bet is
  accepted, so a cancel is a refund path, not a deletion.
- **Auto cash-outs resolve at the crash, not at the moment the target is passed.** The
  money is identical (the target is a fixed point on a fixed curve) but the *event* lands
  late, so a player watching sees their auto-cash-out confirmed at the end of the round.
  Fixing it properly needs per-target timers.
- **The history strip is in-memory**, per instance. It is decoration; anything a dispute
  could rest on is in the event log. A deploy resets it.
- **Round lifecycle events are published by the instance that owns the round** (an
  in-process engine listener). If that instance dies mid-round, the round still finishes
  and settles correctly — PostgreSQL owns that — but the room may miss the crash
  announcement until a client re-reads.
- **The Android build is still unverified** (no Android SDK in this environment, carried
  from P2 §23). Two checklist items under D are open for that reason and are marked open,
  not waived.

## 24. Technical debt

| # | Debt | Impact | Payoff |
|---|---|---|---|
| 1 | **Room-wide realtime replay buffer** (carried from P5 §24, P7 §24) — `onlyTo` is honoured on broadcast but not in the buffer, so a resume can deliver another player's events | None for Crash (its room is public by construction). **A hole-card leak in poker.** | **P9, before any hand is dealt.** This is the blocker, not a nice-to-have |
| 2 | Conformance does not check that a round-based game defines `pendingTimer`, or that a game with hidden state defines `publicView` | A game can forget an optional hook and fail at runtime instead of in CI | P9 |
| 3 | Seed chaining for provable fairness | The series is not pre-committed, only each round | P10 or P14 |
| 4 | Auto cash-out resolves at crash time, not at its own moment | Late event; no money difference | P19 (it is a UX defect) |
| 5 | History strip in memory, per instance | Cosmetic; resets on deploy | P12, alongside the admin round history |
| 6 | Round lifecycle events depend on an in-process listener | A room can miss an announcement across an instance failure | P14 |
| 7 | `match:found` still shows a snackbar rather than navigating (carried from P7) | Crash never emits it, so nothing is broken today | P9, when a match screen exists to navigate to |
| 8 | Startup recovery replays serially (carried from P6) | Slow start with a large backlog | P14 |
| 9 | `game.formations` audit table is written but never read (carried from P7) | None; it is evidence waiting for a reader | P12 |
| 10 | Nothing schedules `AuditChainService.verifyAll()` yet | The verifier is correct and unrun; tampering is detectable, not detected | P12, with the admin reconciliation dashboard |

## 25. Next-phase dependencies

What P9 (poker) can now rely on, and what it must fix first.

**Available:**
- `createOpenMatch` / `joinMatch` / `startMatch` with per-player atomic buy-in — a poker
  sit-down and buy-in, with the `guard` hook for seat rules enforced inside the lock.
- `GamePlayer.meta` for per-player state fixed at join time (sit-out preference).
- `pendingTimer` for deadlines that survive a restart — a poker turn clock.
- `publicView` for the table everyone sees, separate from each player's hole cards.
- A replayable clock, so a time-dependent poker rule (turn timing, auto-fold) replays
  exactly.
- `settleHouseBanked` if any future game needs it; poker is pooled and uses `settle`
  with the existing rake sweep.
- A conformance suite that a second, very different game has now passed.

**Must be fixed first:** debt #1. The realtime replay buffer is room-wide, and poker is the
game where that becomes a hole-card leak. It is listed as P9's blocker in `progress.md`
rather than as a P9 task, because it has to be closed before the first hand is dealt.

**Then STOP** — P8 is complete; P9 is not started.
