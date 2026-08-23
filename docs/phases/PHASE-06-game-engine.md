# Phase 06 — Game engine & contract

## 1. Phase overview
The `GameDefinition` contract and the engine runtime that hosts it: lifecycle, action pipeline, event-sourced persistence, crash recovery, RNG, and settlement through the wallet. Roadmap: `../MASTER_ROADMAP.md` §P6. Both launch games (P8, P9) are plug-ins to what is built here, so the contract must be right before either exists.

## 2. Current status
`COMPLETE` — 2026-08-23.

## 3. Objective
A game can be added by implementing one interface, and gets for free: authoritative state, per-player information hiding, durable event-sourced history, crash recovery, audited randomness, server-side timers, and idempotent settlement.

## 4. Dependencies
P4 (wallet: escrow buy-in, settlement, reversal) and P5 (rooms, sequenced broadcast, timers) — both COMPLETE.

## 5. Preconditions
Migrations 0001–0003 applied; local Postgres/Redis running.

## 6. Existing-code analysis
`WalletService.buyIn/settle` are already idempotent by match id — the engine calls them and adds nothing of its own around money (rule 10). `RealtimeService.broadcast` and `TimerService` provide delivery and deadlines. `AuditService` participates in the caller's transaction, which the void/refund path relies on.

## 7. Scope
1. **`GameDefinition` contract** in `packages/contracts`: `meta`, `init`, `reduce`, `onTimeout`, `playerView`, `isTerminal`, `settle`.
2. **Engine runtime**: registry, match lifecycle (`created → starting → in_progress → settling → settled | voided`), action pipeline (authorise → validate → reduce → persist → broadcast).
3. **Event-sourced persistence**: append-only `game_events` plus periodic `game_snapshots`; PostgreSQL is the record, Redis only a cache.
4. **Crash recovery**: rebuild from snapshot + events; when a match cannot be recovered, void it and refund every buy-in — audited.
5. **RNG service**: CSPRNG with every draw audit-logged, plus a commit–reveal helper for provably-fair games.
6. **Information hiding**: `playerView` is the only serialisation path to a client.
7. **Settlement** via `WalletService`, idempotent by match id.
8. **Turn timers** on P5's timer service.
9. **Reference game** (`coin-duel`), dev-only, exercising every contract hook.
10. **Conformance suite** any game must pass.

## 8. Out of scope
Shipped games (P8/P9), matchmaking (P7 — matches are created directly here), spectators, tournaments, client game UI.

## 9. Architecture considerations
Implements ADR-006, ADR-009 and `../01-architecture/game-architecture.md`. The engine owns `game.*` tables; games own no tables and never import `wallet` (rule 10). Game logic is a pure reducer — no I/O, no clock, no randomness except through `ctx` — which is what makes replay-based recovery sound.

## 10. Database changes
Migration `0004_game.sql`: `game.matches`, `game.match_players`, `game.game_events` (append-only, unique `(match_id, seq)`), `game.game_snapshots`.

## 11. Backend changes
`game-engine` module: contract types, registry, `EngineService`, `MatchRepository`, `RngService`, recovery service, gateway wiring for game actions.

## 12. Flutter changes
None this phase (game screens are P8/P9). The client contract is exercised by the conformance suite.

## 13. API changes
`POST /games/matches` (dev: create a match), `GET /games/matches/:id` (player view), `POST /games/matches/:id/actions`.

## 14. WebSocket changes
Server → client `game:state` (per-player view) and `game:event`; client actions arrive over REST for now so ordering is unambiguous, with the socket used for state distribution.

## 15. Security considerations (MANDATORY)
- **`playerView` is the only path state reaches a client.** Hidden information (hole cards in P9) never leaves the server for a non-owner, enforced by the contract rather than by each game remembering.
- **Every action is authorised against the match roster** and validated by the reducer; an out-of-turn or malformed action is rejected and never mutates state (rule 1).
- **Randomness is server-side only**, from a CSPRNG, and every draw is recorded with its purpose so a disputed hand can be re-examined (ADR-016).
- **Recovery cannot invent money.** A match that cannot be rebuilt is voided and every buy-in refunded through the ledger — never "best guess" settled.
- **Settlement is idempotent by match id**, so a retried or duplicated settle pays once (rule 6, proven in P4).
- **Events are append-only**; the match history is evidence, not a mutable cache.
- Checklist §A, §B and §C.

## 16. Edge cases
Action for a finished match; action from a non-participant; duplicate action id; timer firing after a match ends; crash between reduce and persist; crash between persist and settle; snapshot newer than events; unknown game code; game version changed while a match is in flight; settlement when escrow is short.

## 17. Testing strategy
Conformance suite run against the reference game. Integration: full match lifecycle with real money movement; recovery after simulated crash mid-match; void-and-refund when the event log is unusable; information hiding (one player's view never contains another's secret); RNG draws audited; settlement idempotency end to end.

## 18. Implementation plan
Contract → migration → repository → RNG → engine → recovery → reference game → conformance suite → integration tests → verify.

## 19. Rollback / recovery
`DROP SCHEMA game CASCADE` while no production data exists. Matches in flight during a rollback would be voided and refunded by the same path the engine uses.

## 20. Acceptance criteria
1. The reference game plays a full match end to end with correct ledger movement.
2. A player's view never contains another player's hidden state.
3. A match survives an engine restart mid-play by replaying its event log.
4. An unrecoverable match is voided and every buy-in refunded, with an audit entry.
5. Every RNG draw is recorded and attributable to a match.
6. Settlement is idempotent; a retried settle pays once.
7. Actions from non-participants, out of turn, or after terminal state are rejected.
8. `pnpm verify:all` green.

## 21. Definition of done
As previous phases, plus the conformance suite passing for the reference game.

## 22. Completion report

**Delivered as planned.** All 10 scope items: the `GameDefinition` contract, the engine runtime, event-sourced persistence with snapshots, crash recovery with void-and-refund, the audited RNG service with a commit–reveal helper, `playerView` information hiding, settlement through the wallet, turn timers, the `coin-duel` reference game, and the conformance suite.

**The most valuable thing built here is the conformance suite, and it is tested against itself.** Four deliberately broken variants of the reference game prove it catches what it claims: a `playerView` that leaks another player's secret, a `settle` that pays more than the pot, a non-deterministic reducer, and (via the same machinery) an unvalidated action. A suite that passes everything put in front of it is worse than no suite, so each check has a matching test that makes it fail.

**Three real bugs, all found by tests.**

1. **Replay verification did not verify anything.** `replayAndVerify` re-ran the reducer and reported success if nothing threw — so tampered state, corrupted draws, or logic that had silently diverged would all have passed. It now compares each replayed state against the recorded one, which is what makes recovery a check rather than a ritual. The void-and-refund test corrupts a stored state value and asserts the mismatch is caught.

2. **Honest matches looked tampered with.** Once the comparison existed, every healthy match reported divergence: PostgreSQL `jsonb` does not preserve key order, so a round-tripped state stringifies differently from the in-memory one. Fixed with a canonical serialiser (`platform/serialization/canonical-json.ts`) applied to both sides — the same problem the audit hash-chain solved independently in P1, now with its own tested utility.

3. **The per-game kill-switch was imported but never wired.** Lint caught the unused import; the honest fix was to implement the check, not delete the line. Match creation now consults `game.<code>.enabled` **before any money moves**, and two tests assert the behaviour that matters: a disabled game refuses new matches with both players' balances untouched, and matches already in flight still play to completion. Pulling the switch drains rather than cuts — it must never strand a player's stake in escrow mid-match.

**Guarantees proven end to end** (15 engine + 2 kill-switch integration tests, against real PostgreSQL and Redis):
- Buy-ins land in escrow before a match exists; a full match settles the pot exactly, leaving escrow at zero and the ledger reconciled across a batch of matches.
- The event log is append-only — an `UPDATE` attempt is refused by the database.
- Every RNG draw is recorded against the match that consumed it, so a disputed coin flip is checkable.
- Actions from non-participants, out of turn, malformed, or after the match ends are all rejected, and a rejected action leaves no event behind.
- A player's pick never appears in the opponent's view before the reveal; a non-participant cannot obtain a view at all.
- A healthy match replays cleanly and resumes; an unrecoverable one is voided with every stake refunded and an audit entry written; a match that crashed after deciding but before paying completes settlement exactly once.

**Test evidence.** 82 unit + 87 integration + 18 Flutter, no skips; `pnpm verify:all` green across all 11 lanes.

## 23. Known limitations
- **Recovery is not run at startup.** `RecoveryService.recoverAll()` exists and is tested per match, but nothing invokes it on boot — a deliberate choice while matches are created only by tests, and a required wiring step before P8/P9 ship. Until then a crash leaves matches in `in_progress` until someone calls recovery.
- **State is rebuilt from the newest event on every action**, which is correct but does more work than needed; the snapshot exists to bound replay and is not yet used as the starting point for incremental rebuilds.
- **Match-room authorisation in P5 is still permissive** — the engine knows the roster but has not yet narrowed `canJoin` to participants. That must land with P7/P9, before hidden information travels over rooms.
- **The realtime replay buffer is still room-wide**, so a resume could hand a player events addressed to another (the `onlyTo` field is honoured on broadcast but not in the buffer). This must be fixed before poker (P9) — it is recorded as debt in P5 and repeated here because P9 is where it becomes a leak.
- **No engine-level rate limiting**: a participant can submit actions as fast as the reducer rejects them.
- **`coin-duel` is a fixture, not a product** — two players, one decision each. P8 and P9 will exercise contract corners it does not reach (multi-round state, side pots, per-player timers).
- **RNG is a CSPRNG, not a certified module** (ADR-016 remains PROPOSED); certification is a licensing requirement handled by the compliance track.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| Recovery not invoked at startup | A crash leaves matches mid-flight until someone runs it | Before P8 ships a real game |
| Snapshots stored but not used as a replay starting point | Rebuild cost grows with match length | P9 (poker hands are long) |
| Room-wide replay buffer (from P5) | Would leak per-player events on resume | **Must precede P9** |
| `canJoin` does not check the match roster | Any authenticated user can join a match room | P7 |
| Per-player timers keyed only by match+timer id | Fine for one active timer; poker needs per-seat | P9 |
| No action rate limiting in the engine | Rejected actions are unbounded | P10/P14 |

## 25. Next-phase dependencies
P7 creates matches through the engine instead of the dev endpoint. P8/P9 implement `GameDefinition` and must pass the conformance suite.
