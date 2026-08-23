# Phase 07 — Matchmaking & lobby

## 1. Phase overview
Getting strangers into matches: stake-tiered queues, atomic match formation, the lobby surface, and the seat-reservation primitives poker will build on. Roadmap: `../MASTER_ROADMAP.md` §P7.

## 2. Current status
`COMPLETE` — 2026-08-23.

## 3. Objective
Two players who have never met can join a queue and be seated in a running match — with the guarantee that a formation either seats **everyone and charges everyone**, or seats and charges **nobody**.

## 4. Dependencies
P6 (engine, match creation, settlement) and P5 (rooms, broadcast) — COMPLETE.

## 5. Preconditions
Migrations 0001–0005 applied; local Postgres/Redis running.

## 6. Existing-code analysis
`EngineService.createMatch` currently creates the match, then buys players in **sequentially, each in its own transaction** — so a second player with insufficient funds leaves the first already charged for a match that never starts. P7 must fix that before it can safely form matches from a queue (see §15).

Two debts recorded in earlier phases also land here:
- P5's `canJoin` lets any authenticated user into any `match:*` room; the engine now knows the roster, so the check can be real.
- P6's `RecoveryService` is never invoked at startup; with matches created by matchmaking rather than only by tests, that has to be wired.

## 7. Scope
1. **Atomic match formation** — all buy-ins and the match record commit together, or not at all.
2. **Queues** — Redis, per `(gameCode, stakeTier)`, with atomic multi-player pop so one player cannot be seated twice or into two matches.
3. **Queue lifecycle** — join, leave, heartbeat/TTL, and status; a disconnected client's entry expires rather than blocking a tier forever.
4. **Fairness basics** — a player is never matched with themselves, and never queued into a second match while already in one.
5. **Lobby** — available games, stake tiers, live queue depth and active-match counts; pushed over the `lobby:*` rooms as they change.
6. **Seat reservation** — TTL-held seats, the primitive poker's tables need in P9.
7. **Roster-based room authorisation** — `match:{id}` may be joined only by its participants.
8. **Recovery at startup** — in-flight matches are swept when the process starts.
9. **Flutter lobby** — game list, join/leave queue, and automatic navigation when a match forms.

## 8. Out of scope
Poker tables themselves (P9 uses these primitives), skill/rating matchmaking beyond a stub, private tables, spectators, tournaments.

## 9. Architecture considerations
Implements `../02-domains/matchmaking.md`. Queues are Redis-only and disposable (rule 7): losing them costs players their place in line, never money or match state. Formation is the one step that must be atomic, and PostgreSQL — not Redis — is what makes it so.

## 10. Database changes
Migration `0006_matchmaking.sql`: `game.stake_tiers` (configurable per game) plus a `queue_entries` audit trail of formations. Live queues stay in Redis.

## 11. Backend changes
`matchmaking` module: queue service (Lua-backed atomic pop), formation service, lobby service, controller, gateway hooks. `EngineService.createMatch` and `WalletService.buyIn` gain transaction-scoped variants.

## 12. Flutter changes
`features/lobby`: game list with tiers and queue depth, join/leave, matched-navigation.

## 13. API changes
`GET /lobby`, `POST /lobby/queue`, `DELETE /lobby/queue`, `GET /lobby/queue`.

## 14. WebSocket changes
`lobby:{gameCode}` rooms carrying `lobby:update`; `match:found` delivered to each seated player's user room.

## 15. Security considerations (MANDATORY)
- **All-or-nothing formation.** Buy-ins for every seated player commit in one transaction with the match record. A partial formation would take one player's stake for a match that never existed — the worst failure this phase can have.
- **A player cannot be seated twice**, in one match or in two simultaneous ones: the queue pop is atomic (a Lua script, so no interleaving between check and remove), and active-match membership is re-checked inside the formation transaction.
- **Room membership is now authorised against the roster** — closing P5's permissive `canJoin`, which mattered little with no real matches and matters a great deal with them.
- **Queue entries carry no PII** — user id and tier only.
- **Rate limiting** on queue join, so a client cannot thrash formation.
- **Insufficient funds is refused before seating**, not discovered mid-formation.
- Checklist §A, §B, §C.

## 16. Edge cases
Two players racing for the last seat; a player queued twice from two devices; a player who queues then loses their connection; funds spent between queueing and formation; Redis flushed mid-queue; a game disabled while players are queued; formation failing after the match row exists; a player already in an active match.

## 17. Testing strategy
Integration against real Postgres/Redis: concurrent joins forming exactly one match per pair with no double-seating; a formation where one player cannot pay leaves **nobody** charged; leave/expiry; roster authorisation refusing a non-participant; startup recovery sweeping an in-flight match.

## 18. Implementation plan
Atomic formation fix → queue service → formation → lobby → roster auth → startup recovery → Flutter → tests → verify.

## 19. Rollback / recovery
Additive migration; queues are disposable. Matches already formed are unaffected by reverting matchmaking.

## 20. Acceptance criteria
1. Two queued players are formed into one match, both charged, exactly once.
2. A formation in which any player cannot pay charges nobody and seats nobody.
3. Concurrent joins never double-seat a player or form overlapping matches.
4. A non-participant cannot join a match room.
5. Queue entries expire; leaving works; a disabled game refuses new queueing.
6. In-flight matches are recovered at startup.
7. `pnpm verify:all` green.

## 21. Definition of done
As previous phases, plus the all-or-nothing formation test passing.

## 22. Completion report

**Delivered as planned.** All 9 scope items: atomic formation, Redis stake-tier queues with a Lua-backed atomic claim, queue lifecycle with TTL, fairness checks, the lobby surface, seat/tier configuration, roster-based room authorisation, startup recovery, and the Flutter lobby.

**The headline guarantee is proven by removing it.** A formation seats everyone and charges everyone, or nobody. To confirm the test earns its place I temporarily restored the old sequential buy-in and re-ran it: the innocent player was charged 5,000 for a match that never started (`Expected: 10000, Received: 5000`). With buy-ins committed in one transaction alongside the match record, their balance is untouched. That was P6's `createMatch` behaviour and would have started taking real players' stakes the moment matchmaking went live.

**Two debts from earlier phases closed.**
- **Room authorisation now checks the roster** (P5 debt). Any authenticated player could previously join any `match:*` room — harmless with no real matches, a spectator hole with them. Six P5 tests had been joining rooms for matches that did not exist; they now build real rosters, and a new test asserts a stranger's match is refused.
- **Recovery runs at startup** (P6 debt), non-fatally: an instance that cannot recover still comes up, because one bad match must not keep the platform down.

**Three bugs found by running the code, not by tests.**

1. **Free-play matches could never settle.** A zero-stake settlement produces a single zero ledger entry, which the ledger correctly refuses — so any match on the free tier would have hung in `settling` forever. Found by startup recovery failing on leftover matches; the lobby offers a free tier, so this was on a live path. Now a settlement that moves no money records nothing, and two tests cover settle and void at zero stake.
2. **Recovery only swept the first 100 matches.** A resumed match stays `in_progress`, so a `LIMIT`-only query re-read the same page forever and never reached the rest — 139 were in flight, 100 were looked at. Now cursor-paged through the whole set, bounded, and it reports loudly if the bound is hit.
3. **Recovery logged every match id on one line.** Unreadable at 100 matches, useless at 10,000. It now logs counts, and names only voided matches — the ones where money moved and a human should look.

Also fixed: `forRoutes('*')` is deprecated under Express 5 and warned on every boot.

**Test evidence.** 16 matchmaking + 19 engine + 20 realtime integration tests, 106 integration and 82 unit in total, no skips. Beyond the atomicity proof: four simultaneous joins form exactly two matches with every player seated once and charged once; eight concurrent claims never hand the same player to two callers; a stale queue entry is dropped rather than blocking the tier; queueing is refused for insufficient funds, for a player already in a match, and for a disabled game. Verified on a live boot: 126 in-flight matches swept in one pass, and `/lobby` refuses an unauthenticated caller.

## 23. Known limitations
- **Formation is triggered by joins and a manual sweep** — there is no background sweeper, so a player left alone in a tier waits until someone else joins. `MatchmakingService.sweep()` exists; scheduling it on BullMQ is a small piece of P8 work.
- **Seat reservation is not implemented.** Queue-based formation covers P8's needs; poker's table/seat model (reserve, sit, top-up) is P9, which is where a reservation TTL has meaning.
- **Matchmaking is FIFO within a tier** — no rating, no wait-time widening, no collusion-aware seating. The rating hook is a stub, and P10's risk engine is what should eventually inform seating.
- **Queue depth is approximate**: stale entries are pruned only when a claim walks past them, so the lobby can overstate a tier briefly.
- **The Flutter lobby polls rather than subscribes.** `lobby:{gameCode}` rooms are broadcast server-side and the client does not yet listen; it refreshes on action and pull. Wiring the socket is P8, alongside the first real game screen.
- **`match:found` is delivered but the client does not navigate on it** — it shows a snackbar. Match screens arrive with P8/P9.
- **Two framework warnings remain on boot** about `/api/v1/*` route conversion, from Nest's own global-prefix handling; behaviour is correct and covered by tests.

## 24. Technical debt
| Item | Impact | Payoff |
|---|---|---|
| No scheduled formation sweeper | A lone player waits for another join rather than a timer | P8 |
| Lobby client polls instead of subscribing | Queue depths are stale between refreshes | P8 |
| Startup recovery replays every in-flight match serially | Slow boot with a large backlog (126 matches took seconds) | P14 — parallelise or defer to a worker |
| Formation audit (`game.formations`) is written but never read | No operator view of failed formations | P12 |
| Seat reservation primitive outstanding | Poker cannot hold a seat during buy-in | P9 |
| Realtime replay buffer still room-wide (from P5) | Would leak per-player events on resume | **Must precede P9** |

## 25. Next-phase dependencies
P8 and P9 create matches through matchmaking; P9 uses seat reservation for tables.
