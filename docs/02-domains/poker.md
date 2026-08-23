# Domain: Poker

NestJS module `games/poker` — a `GameDefinition` plugin plus table/seat management on the matchmaking rails. Built in **P9** (highest-complexity phase). Variant per **OQ-07 recommendation: No-Limit Texas Hold'em cash tables** (recommendation, not decision — table/seat/hand architecture below is variant-agnostic where cheap; NLHE specifics are marked). Tournaments, other variants: out of scope (§15).

Related: `docs/02-domains/game-engine.md` (contract, recovery, invariants), `docs/02-domains/matchmaking.md` (table directory, seat reservation), `docs/02-domains/wallet.md` (escrow), `docs/02-domains/fraud-risk.md` (collusion detection — this doc only exports data, §14).

## 1. Model overview

- **Table** = long-lived cash-game venue: 2–6 seats, one stake tier, config (§2). Owned here.
- **Hand** = one engine match (`GameDefinition` instance) — pinned game version, own event log, lifecycle `created→…→settled|voided` per engine canon. A table session is a sequence of hand-matches.
- **Stacks** = game state, truth in the hand event log, financially backed by the table escrow (§5).

## 2. Owned data

| Table (PG) | Contents |
|---|---|
| `poker_tables` | id, stake tier ref (blinds SB/BB, min/max buy-in as BB multiples, e.g. 40–100 BB), seat count (2–6), config JSONB (turn timer, timebank, rake — §12/§4), status (open/closing/closed), kill-switch scope ref |
| `poker_seats` | table_id, seat_no (unique among active), user_id, stack (BIGINT minor units — cached; event log is truth during a hand), state (`seated/sitting_out/reserved-…/standing`), sat_at, sit_out_since, escrow refs |
| `poker_hands` | hand_id = match_id (FK to `matches`), table_id, hand_no (per-table monotonic), button seat, blinds posted, board summary, pot/rake totals, showdown summary (public info only) |

Hole cards, deck order, per-action detail: **only** in `game_events`/`rng_draws` (engine-owned), never in poker tables.

## 3. Seat & session flows

- **Sit:** reservation via matchmaking (`matchmaking.md §4`) → buy-in (chosen within tier min/max) escrowed → seat active. Player is dealt into the next hand (never mid-hand).
- **Top-up:** allowed between hands only, up to tier max (`stack + top-up ≤ max buy-in`); escrow debit like buy-in; applied before next deal. Requested mid-hand → queued.
- **Sit-out:** voluntary or disconnect-driven (§9). Sitting-out player is skipped in dealing; seat retained.
- **Stand/leave:** takes effect at hand boundary; current stack transferred escrow → wallet (idempotent per seat-session id). Leaving mid-hand: §11.
- **Ratholing rule (v1):** re-sitting the same tier within a cooldown (config, e.g. 1h) requires buy-in ≥ min(previous leave stack, tier max) — cheap-to-implement fairness rule, config-off in dev.

## 4. Hand lifecycle (the `GameDefinition`)

NLHE hand as reduce steps; states inside `GameState`:

```
waiting_deal → blinds → dealing → bet_preflop → deal_flop → bet_flop
             → deal_turn → bet_turn → deal_river → bet_river
             → showdown → payout(terminal)
   (any betting state → payout early if all-but-one fold, or → runout if all-in)
```

- `init(ctx, players, config)`: seats/stacks snapshot ("stacks as of hand start" — the void-restore point, §10), button position, deck = Fisher–Yates shuffle over `ctx.rng` (draws audit-logged; commit-reveal not used for poker v1 — hole-card secrecy, not pre-commitment, is the fairness surface; revisit only via ADR).
- `reduce` actions: `postBlind` (engine-driven small/big blind; missed-blind rules §9), `fold`, `check`, `call`, `bet`, `raise`, `allIn`, `show`, `muck`. Every action validated: actor is the to-act seat, amount legal (§6), state legal. Illegal → rejected event, no state change (engine invariant 12.1/13).
- Street transitions and board dealing are engine-actor events produced by `reduce` when a betting round closes (all active players matched or all-in).
- `onTimeout`: turn timer → timebank consumption → auto-action (§8); disconnect grace timers (§9).
- `isTerminal`: payout state reached. `settle`: §5.
- `playerView`: §7 — the load-bearing information-hiding surface.

## 5. Money: escrow model & rake

Poker refines the canonical per-match escrow (`system-rules.md` rule 10, engine §7) to a **table-scoped escrow** (a `match_escrow`-class account per table instance), because stacks persist across hand-matches:

- **Sit/top-up:** user wallet → table escrow (idempotent ledger transaction).
- **During hands:** chips move between stacks/pots as game state only — no ledger rows per bet.
- **Per-hand `settle` (idempotent by hand/match id):** ledger movement is **rake only** (table escrow → house `rake` account); stack deltas are recorded in `poker_hands`/match outcome and the event log.
- **Stand/table close:** stack → user wallet from table escrow.
- **Invariants (reconciliation job, wallet domain):** `table escrow balance == Σ seated stacks + pots of in-progress hand` at all times; escrow zeroes out at table close (the canonical "escrow zeroes at settlement" invariant, scoped to the table session). Drift pages a human and freezes the table.

**Rake:** implemented from day one, **config 0 on `TST`** test currency. Model: capped percentage — `rake = min(pot × rate, cap)` per hand, taken from the pot at payout; **no flop, no drop** (no rake on hands ending pre-flop); side-pot-aware (raked on total pot, deducted proportionally from awarded pots). Rate/cap per stake tier config. Real values are a business + jurisdiction decision at P15/P18.

## 6. Betting rules (NLHE)

- **Min bet** = 1 BB. **Min raise** = size of the previous bet or raise increment on that street (a raise to X after a bet of B requires `X − B ≥ B − prior level`, i.e. the increment never shrinks).
- **All-in below min-raise** does **not** reopen the action: players who already acted may only call the additional amount or fold; a full-raise all-in reopens normally.
- Bets are chip-exact integers (minor units); no fractional-BB weirdness because `TST`/fiat minor units divide blinds by construction (tier config validated for this).
- **Uncalled excess** (a bet/raise nobody matches) returns to the bettor before pot construction.

**Side-pot algorithm (normative — implement exactly this):**
1. At payout, let `committed(p)` = total chips player `p` put in this hand (blinds + all streets), after returning any uncalled excess.
2. Let `L₀ = 0 < L₁ < L₂ < … < Lₖ` be the distinct `committed` values of **all-in players still in the hand**, ascending, plus `Lₖ₊₁ = max committed` if any non-all-in players remain above `Lₖ`.
3. For each layer `i` (1…k+1): `pot_i = Σ over all players p of (min(committed(p), Lᵢ) − min(committed(p), Lᵢ₋₁))` — folded players' chips are included in the layer sums but folded players are never eligible.
4. Eligibility for `pot_i` = non-folded players with `committed(p) ≥ Lᵢ`.
5. Award each pot (main = layer 1, then side pots in order) to the best eligible hand; ties split equally; odd remainder chips go to the eligible winner closest to the button's left (first in deal order). 
6. Property (conformance-tested): `Σ pots + returned excess + rake = Σ committed`; every chip is either awarded, returned, or raked.

Hand evaluation: standard 7-card NLHE evaluator, exhaustively tested against known vectors (P9 test plan).

## 7. Information hiding (`playerView`)

- Hole cards appear **only** in the owner's view — enforced at the contract level (rule 2), verified by the conformance suite's leak tests (engine §13) plus poker-specific adversarial tests.
- Deck, undealt cards, and burn order appear in **no** view, ever.
- **Showdown reveal rules:** at showdown, hands are revealed in order (last aggressor first, then clockwise); a player facing a shown better hand may **muck** — mucked cards are recorded in the event log (for disputes/collusion analysis) but never broadcast to players. All-in runouts reveal all live hands (standard cash rule) at the moment betting can no longer occur, not before.
- Public view (all players/table): board, pot(s), stacks, bets, actions, timers, revealed showdown hands. Fold does not reveal.
- Reconnect resync sends the caller **their own current `playerView` only** — see §16 (hole-card probing).

## 8. Turn timers & timebank

Per tier config: turn timer (default 15s) + per-player **timebank** (default 30s, refilled +5s per N hands up to cap). Timer expiry order: consume timebank automatically → then auto-action: **check if legal, else fold**. All timers server-side via the engine/P5 timer framework; client countdowns cosmetic. Facing no bet with timebank exhausted repeatedly is a sit-out trigger (§9).

## 9. Disconnects & sit-out

- Disconnect detected (presence loss) mid-hand → **grace period** (config ~10s) folded into the running turn timer, then normal timeout path (timebank → auto-check/fold). The hand never waits beyond the timer for anyone (protects remaining players).
- After M consecutive auto-actions or on timeout while disconnected → seat state `sitting_out`; player skipped from subsequent deals, stack stays escrowed at the table.
- **Blinds while sitting out:** no dead-blind accumulation in v1 — returning player must either post BB immediately or **wait for the big blind** to be dealt back in (prevents blind-dodging). Sitting out past a limit (config, e.g. 10 min or 2 orbits) → auto-stand (stack returned to wallet).
- Bets already made stand; disconnection never refunds committed chips (server-authoritative; anything else is an abuse vector).

## 10. In-flight-hand crash recovery

Engine-standard (engine §9): snapshot + event replay with logged RNG draws reproduces the exact hand state — including hole cards and deck — and play resumes; players experience a reconnect. **Unrecoverable** (replay fails, version gone):
- Hand → `voided`; **stacks restored to hand start** (the `init` snapshot) inside table escrow — committed chips returned, no rake; ledger untouched except reversing any (only-possible) rake row if settle had partially run — which it cannot, settle is atomic; so normally zero ledger movement.
- `match_voided` event + hash-chained audit entry + risk signal (void frequency per table/user is a fraud indicator).
- Table continues with the next hand if healthy, else table closes (stacks → wallets).

## 11. Leaving mid-hand

Allowed but never advantageous: the leaver's hand is **folded at their next turn** (committed chips stay in the pot — they forfeit them like any fold); stack is returned at hand end, not instantly. Kill/close of the app is just a disconnect (§9) — same outcome. There is no path where leaving retrieves chips already committed to a pot.

## 12. Table config (per tier / table)

`{ seats: 2–6, blinds: {sb, bb}, buyIn: {min, max} (BB multiples), turnTimer, timebank: {initial, refill, cap}, graceDisconnect, sitOutLimit, rake: {rate, cap} (0 on TST), ratholeCooldown }` — validated against the definition's `stakeConfigSchema`; tier rows versioned, never edited in place (matchmaking §9).

## 13. Multi-table

One user may hold seats at **multiple tables** (config cap, e.g. 4): the model requires nothing special — each table/hand is independent (own rooms, own timers, own escrow); the client renders one table at a time in v1 UI with switch affordance (UI scope in P9 plan). Same-table multi-seat by one user is forbidden (unique `(table_id, user_id)` among active seats) — trivially collusion.

## 14. Anti-collusion surface (data out, logic elsewhere)

Poker exports to the risk engine (P10; detection logic in `fraud-risk.md`): complete hand histories (from event log, including mucked cards and folds), seating patterns (who sits with whom, join/leave timing — via matchmaking export), chip-flow aggregates per user-pair (who loses to whom, abnormal fold-to-raise rates, chip-dumping shapes), device/IP overlap at table (from session data). Poker itself takes no detection decisions; it honors risk actions (freeze → sit-out + stand at hand end, escrowed stack held pending review).

## 15. Out of scope (v1) — with extension notes

| Excluded | Extension path |
|---|---|
| Tournaments / Sit-n-Go (OQ-07) | new lifecycle layer above hands (registration, blind schedule, table balancing); hand engine reused unchanged |
| Other variants (PLO, etc.) | new `GameDefinition` sharing evaluator/side-pot libs; betting-rule module swapped |
| Chat | realtime feature, heavy moderation/collusion surface — deliberate omission |
| Stats UI / HUDs | data already in event log; product decision later |
| Private/invite tables | removed collusion vector until risk tooling matures (matchmaking §7) |

## 16. Adversarial edge cases (tested in P9)

- **Out-of-turn actions:** rejected (actor ≠ to-act seat), no state change, no information leak in the rejection; repeated attempts → risk signal.
- **Invalid raise sizes:** below min-raise / above stack / wrong increment → rejected with the legal bounds (bounds are public info); never coerced-and-accepted.
- **Acting for others:** actor identity comes from the authenticated WS session, never from payload; payload-declared seat ignored/rejected on mismatch.
- **Hole-card probing via reconnect resync:** resync returns `playerView(state, callerId)` only; there is no parameter to request another player's view; conformance + adversarial protocol tests assert no event ever carries another player's hole cards (P9 acceptance: "no information leak found by protocol tests").
- **Timer manipulation:** client clocks are cosmetic; all deadlines server-side (rule 2). Deliberate slow-play is bounded by timer+timebank.
- **Simultaneous stand + deal race:** stand takes effect at hand boundary under the table's deal lock — a player is either in the dealt set (plays the hand) or stood (excluded), never half.

## 17. Metrics

Hands/hour per table, occupancy, void rate, auto-action (timeout/disconnect) rate, timebank usage, pot size distribution, rake (0 expected on TST — nonzero alerts), reconnect-resume success rate, collusion-export lag.

## 18. Phase mapping

**P9** everything above on test currency; **P7** rails consumed (tables/seats); **P10** collusion detection consumes §14; **P12** table ops in admin (live view, kill, void oversight); **P14** full-table load + mid-hand chaos drills (acceptance: 6-player real-device hand survives mid-hand server kill); **P18** RNG certification covers the shuffle (ADR-016), real-currency rake config per license.
