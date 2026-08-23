# Domain: Game Sessions

NestJS module `game-sessions` — the durable record of matches: who played what, for what stakes, when, and how it ended. The engine (`docs/02-domains/game-engine.md`) owns live state and rules; game-sessions owns the **database truth of match existence and lifecycle** that matchmaking, wallet reconciliation, lobby/history APIs, support, and risk all read. Built in **P6** alongside the engine (the engine cannot run without match rows), extended by P7 (formation) and P8/P9 (real games).

## 1. Purpose

- Persist match records from formation to terminal state; be the queryable, relational counterpart to the engine's event log.
- Serve player-facing session APIs: active matches (resume list), match history.
- Serve support/dispute lookup: from a match id or user complaint to a full replayable record.
- Provide the reconciliation anchor: `escrow == open matches` (wallet job) joins against this module's tables.

## 2. Owned data

| Table (PG) | Contents |
|---|---|
| `matches` | id (UUIDv7), game_code, game_version (pinned, see engine §11), stake_config JSONB (tier, buy-in, currency `TST` at launch), state (`created/starting/in_progress/settling/settled/voided`), created_at, started_at, settled_at/voided_at, void_reason nullable, origin (queue \| table) + origin ref (queue tier id / table id) |
| `match_participants` | match_id, user_id, seat/position, buy_in_amount, outcome summary per player (net amount, result tag e.g. won/lost/folded/voided), joined_at, left_at nullable |
| `match_outcomes` | match_id, outcome summary JSONB (game-declared shape: winners, final multiplier, pot breakdown…), settlement ledger_transaction_id ref, rake_amount |

Not owned: `game_events`/`game_snapshots`/`rng_draws` (engine), ledger tables (wallet), queue/reservation structures (matchmaking, Redis). Cross-module access via exported services only (rule 20).

Poker nuance: a cash **table session** spans many hands; each hand is one engine match. `matches.origin` links hands to their table; the poker domain owns table/seat tables (`poker.md §2`), game-sessions owns the per-hand match rows.

## 3. Relationships

```
matchmaking ──creates──► matches(created) ──hands over──► game-engine
     │                        ▲    ▲                          │
     │ origin ref             │    │ lifecycle events         │
     ▼                        │    └──────────────────────────┘
  table/queue            wallet: buy-in → match_escrow (before handoff)
                         wallet: settlement/refund ref stored on match_outcomes
```

- **Matchmaking → sessions:** atomic match formation writes the `matches` + `match_participants` rows (via this module's service) in the same flow that funds escrow — a match row in `created` implies funded escrow (queue model) or is created seat-by-seat as buy-ins land (table model; see `matchmaking.md`).
- **Engine → sessions:** the engine emits in-process domain events on every lifecycle transition; this module updates `matches.state` + timestamps in the same PG transaction that commits the corresponding `game_events` row, so DB lifecycle truth never disagrees with the event log.
- **Wallet:** never called from here; this module only stores the settlement transaction reference reported by the engine, and exposes match queries the wallet reconciliation job consumes.

## 4. Lifecycle states

Mirrors the engine's canonical machine exactly — `created → starting → in_progress → settling → settled | voided` — with **PG as truth** (rule: Redis never holds truth). Legal transitions enforced by a guarded state-column update (CHECK/transition assertion in the service + covered by tests); an out-of-order update indicates an engine bug and fails loudly. Timestamps (`started_at`, `settled_at`, `voided_at`) are set exactly once.

## 5. Services / API surface

In-process (exported services):
- `createMatch(gameCode, gameVersion, stakeConfig, participants, origin)` — used by matchmaking inside formation transaction.
- `transition(matchId, toState, meta)` — engine-only.
- `openMatchesFor(userId)`, `openMatchesByGame(code)` — engine recovery sweep, kill-switch drain accounting, reconciliation.

REST (`/api/v1`, conventions per `docs/03-api/api-conventions.md`):
- `GET /sessions/active` — caller's non-terminal matches with resume payload (matchId, game code, WS room, seq hint) → powers the app's "return to game" affordance after reconnect/restart.
- `GET /sessions/history?cursor=` — settled/voided matches, per-player outcome summary; cursor-paginated.
- `GET /sessions/:matchId` — detail if caller participated (or admin role): participants, stakes, outcome, timestamps. Never raw `game_events` to players — hidden information stays hidden after the match too, except what the game's showdown/reveal rules already made public (the outcome summary is built from public events only).

Admin (P12): match search, full event-log view, void oversight, replay trigger.

## 6. Player-session view

The mobile app treats "am I in a game?" as server truth: on login/reconnect it calls `GET /sessions/active`; any entry routes into the game screen which resumes over WS (`resume(matchId, lastSeq)` per realtime protocol). One user may have multiple concurrent matches only where the game allows it (poker multi-table: yes; queue games: matchmaking blocks joining a queue for a game you're already in as of v1 policy — configurable per game).

## 7. Spectators

**Not at launch.** The design doesn't preclude it: broadcasting already goes through per-recipient `playerView`, so a spectator is just a recipient with `playerId = null` receiving the public view; room membership and authz would gate it. No spectator code paths, tables, or API stubs are built until a phase plan calls for it — noted here so no design choice forecloses it (e.g. never assume room membership ⇒ participant).

## 8. History retention & dispute lookup

- `matches`/`match_participants`/`match_outcomes`: retained indefinitely at launch scale (they are small); retention/archival policy becomes jurisdiction-driven at P15 (record-keeping duties are a license term — candidate config in `docs/06-compliance/jurisdiction-matrix.md`).
- `game_events` + `rng_draws`: retained per the same policy; `game_snapshots` prunable to latest-per-match after terminal state.
- **Dispute flow (support):** match id → event log replay (engine's deterministic replay, §9/§12.7 of engine doc) reproduces every intermediate state and every RNG draw; admin panel (P12) renders the timeline. Combined with the audit log for any void/adjustment, this answers "what exactly happened in my game" without trusting anyone's memory or the client.

## 9. Metrics

Concurrent matches (by game/stake tier), match duration histogram, matches formed vs completed vs voided (void rate by reason alerts), abandonment (participant disconnected through to settlement without returning — feeds risk + UX), settlement→history visibility lag. Dashboards per game code; concurrency numbers are the capacity-planning input for P14 load targets.

## 10. Phase mapping

**P6** tables, lifecycle mirroring, in-process services, active/history API minimal; **P7** formation integration (origin refs); **P8/P9** real games populate outcome summaries; **P10** abandonment/void signals to risk; **P12** admin match tooling; **P14** retention under load, history query performance; **P15+** retention becomes jurisdiction-configured.
