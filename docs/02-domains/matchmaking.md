# Domain: Matchmaking & Lobby

> **P8 note.** Matchmaking now covers only games that declare `mode: 'matchmade'`. Round
> games (Crash) have no queue: their betting window *is* the queue, and joining one goes
> through the engine's open-roster admission instead (ADR-023). `joinQueue` refuses a round
> game explicitly rather than enqueueing someone no formation will ever read, the lobby
> reports each game's `mode` so the client routes on it, and the sweep skips them. The
> scheduled formation sweep — carried as debt from P7 — now runs as a BullMQ job.

NestJS module `matchmaking` — gets strangers into matches and shows them what's available to play. Built in **P7** on top of the engine (P6) and real-time core (P5). Two formation models, one financial rule: **money moves only at confirmed seat/match**, via wallet escrow — so no queue or reservation failure can ever strand funds.

Related: `docs/02-domains/game-engine.md` (discovery, handoff), `docs/02-domains/game-sessions.md` (match records), `docs/02-domains/wallet.md` (escrow), `docs/02-domains/poker.md` (table specifics), `docs/01-architecture/realtime-architecture.md` (`/lobby` namespace).

## 1. Purpose

- **Queue-based matchmaking** for casino/head-to-head games: join a queue for (game, stake tier), get matched, play.
- **Table-based matchmaking** for poker: browse a table directory, reserve a seat, buy in, sit.
- Lobby data: what games/tables/tiers exist, occupancy, queue depth — REST snapshot + `/lobby` WS updates.
- Fairness basics and anti-abuse hooks; full detection lives in `fraud-risk.md` (P10).

## 2. Owned data

PG (truth / audit): `stake_tiers` (game_code, tier id, buy-in or blinds config, min/max, currency, status active/retired), `queue_audit` (join/leave/match/timeout events for support & risk), table directory rows for poker (`poker_tables` — owned jointly with the poker domain: matchmaking owns directory/occupancy metadata, poker owns game config; single table, poker module is the writer of game config columns). Formed matches are written via `game-sessions.createMatch` — matchmaking owns no match rows.

Redis (operational, rebuildable): queues `mm:q:{game}:{tier}` (sorted set by enqueue time), queue membership index per user, seat reservations `mm:seat:{tableId}:{seatNo}` (value userId, **TTL ~20s**), formation locks, lobby occupancy counters.

## 3. Model A — queue-based (casino & h2h games)

**Join:** `POST /matchmaking/queue` (game, tier) → authz (session, account active, not self-excluded, per-game kill-switch not draining, balance ≥ tier buy-in — a soft precheck only; the real check is the escrow debit at formation), enqueue in Redis, audit row, ack with queue position estimate.

**Formation (atomic):** a formation worker (BullMQ, competing consumers) per (game, tier):
1. Acquire formation lock `mm:form:{game}:{tier}` (Redis).
2. Pop N candidates FIFO (N = game's minPlayers..maxPlayers window per its meta).
3. Filter: still-connected (presence), not self-match (§6), risk pairing check (§7).
4. **Single PG transaction:** create `matches` row + participants (via game-sessions) **and** execute buy-in escrow debits (user wallet → `match_escrow`) for all N, idempotency key `mm:{matchId}:{userId}`. Any debit fails (insufficient funds since precheck) → transaction rolls back, that user is dropped from candidates with a notification, others return to the **head** of the queue (retain FIFO position).
5. Commit → hand match to engine (`created`), notify players over `user:{id}` rooms → clients navigate to `/game`.
6. Release lock. Redis queue removal happens after commit; a crash between commit and removal is resolved by the join-time check "already in an open match for this game" (game-sessions `openMatchesFor`), which wins over queue membership.

**Timeout/cancel:** `DELETE /matchmaking/queue` any time before formation commit; server-side max queue wait (per tier config) → auto-remove + notify. Cancellation races formation: the formation transaction re-checks membership tokens; a user whose leave landed first is skipped. No money has moved in any of these paths.

## 4. Model B — table-based (poker)

**Directory:** `GET /lobby/tables?game=poker&tier=` → tables with seat occupancy, stakes, avg pot (later). Live deltas over `/lobby` WS.

**Sit flow:** `POST /tables/:id/seats/:n/reserve` → seat reservation in Redis with TTL (~20s), one active reservation per user. Client confirms with buy-in amount (within tier min/max) → `POST /tables/:id/sit`: **single PG transaction** — validate reservation ownership, escrow debit (user → table/hand escrow model per `poker.md §5`), seat assignment persisted. Reservation TTL expiry → seat silently frees, nothing to refund (buy-in only happens at confirmed sit — the invariant that makes Redis loss financially harmless). Stand/leave per `poker.md §6`.

## 5. Lobby surface

REST: game list (from engine discovery, excluding draining/disabled), stake tiers, queue depth (approximate), table directory. WS `/lobby` namespace: `v1:lobby:queue_depth`, `v1:lobby:table_update` (occupancy deltas), `v1:lobby:game_status` (kill-switch state changes) — throttled/coalesced (≤1 update/sec per entity), per-room `seq` like all WS events. Lobby data is public-ish (no hidden info), but still authenticated.

## 6. Fairness basics (v1)

- **FIFO within a stake tier** — no priority lanes, no rating at launch.
- **No self-match** for head-to-head games: same user (and same device/household per risk graph, best-effort) never matched against themselves via multiple accounts — a hard filter here even though multi-accounting detection proper is P10.
- **Rating/skill matching: stub only.** Formation filter interface takes an ordered candidate list and returns approved groupings; the v1 implementation is FIFO-pass-through. A future rating service implements the same interface (candidate OQ when prioritized; not needed for launch — noted for the consistency pass).

## 7. Anti-abuse hooks (design now, detect later — P10)

- Every formation emits pairing metadata to the risk engine: who matched with whom, device/IP overlap flags, repeat-pairing counts.
- **Repeated-pairing heuristic (v1):** same pair matched > N times in window → flag to risk review; matchmaking may soft-deprioritize pairing them (config off by default).
- Table model exports seating patterns (who sits with whom, buy-in/leave timing) — collusion analysis itself lives in `fraud-risk.md`; matchmaking only guarantees the data exists.
- No "friendly seating" features (invite-to-table, private tables) at launch — explicitly out of scope, removing the easiest collusion vector until risk tooling matures.

## 8. Failure handling

| Failure | Behavior |
|---|---|
| Redis loss/flush | Queues and reservations vanish; clients get a `queue_reset` lobby event (or discover on next poll) and re-join. **No stuck escrow possible** — money only moves inside the PG formation/sit transaction. Occupancy counters rebuild from PG (seats, open matches). |
| Formation worker crash mid-transaction | PG rolls back — no match, no debits; candidates remain queued (membership re-verified). |
| Crash after commit, before notification | Match exists + escrow funded; engine recovery sweep (`openMatchesFor`) surfaces it; clients find it via `GET /sessions/active`. |
| Kill-switch → draining mid-queue | Queue closed, members notified + removed; in-flight matches unaffected (engine §10). |

## 9. Edge cases

- **Simultaneous last-seat claims:** reservation is a Redis `SET NX` — exactly one winner; loser gets `seat_taken` immediately. Two *sit* commits can't race: seat assignment has a PG unique constraint `(table_id, seat_no)` among active seats — the constraint, not the Redis reservation, is the correctness guard.
- **Queued user disconnects:** presence loss starts a grace (~30s); still absent at formation-filter time → skipped and dequeued (audit row). Reconnect within grace keeps position.
- **Stake-tier config change mid-queue:** tiers are versioned rows, never edited in place — a retired tier's queue is closed (members notified, nothing to refund), the new tier starts empty. Formation always reads the tier row pinned at queue creation, so a formed match's stakes are always the stakes the user saw.
- **User in queue starts another game** (e.g. sits at a poker table): v1 policy — joining a table/second queue removes them from incompatible queues; `openMatchesFor` guards the race.
- **Insufficient funds at formation** (spent between precheck and formation): handled in §3 step 4 — dropped with notification, no partial match.

## 10. Metrics

Queue depth + wait time (p50/p95) per (game, tier); formation success/abort rates by cause; reservation conversion (reserve→sit); seat occupancy; time-to-match SLO input for P14 matchmaking-storm tests; repeat-pairing counter (risk).

## 11. Phase mapping

**P7** everything above with coin-duel as the test game (acceptance: two fresh accounts match end-to-end); **P8** first real queue game; **P9** table model exercised by poker; **P10** risk hooks consume pairing/seating exports, heuristics tuned; **P14** matchmaking storms + Redis-flush chaos drills.
