# Crash — game rules and fairness note

The published rules of `crash`, the first shipped game (P8, OQ-05). Implementation:
`apps/api/src/games/crash/`. Contract: ADR-009. Admission: ADR-023. Settlement: ADR-024.

Everything in this document is what the server actually does. The arithmetic below is the
arithmetic in `crash.math.ts`, and a player can recompute any finished round from it.

## 1. How a round works

1. **Before betting opens**, the server generates a 32-byte random `serverSeed`, computes
   the round's crash point from it, and publishes `sha256(serverSeed)` — the *commitment*.
   The outcome is fixed at this moment, before any bet exists.
2. **Betting window** (7 seconds by default). Players bet an amount within the tier's
   bounds and may set an optional auto-cash-out target. The stake moves into the round's
   escrow when the bet is accepted, not later.
3. **Flight.** The multiplier rises from 1.00× in steps of 100 ms.
4. **Crash.** The round ends the first moment the multiplier reaches the crash point.
   Players who cashed out keep stake × their multiplier; everyone still riding loses
   their stake to the house.
5. **Reveal and settle.** The `serverSeed` is published, payouts are posted in one ledger
   transaction, escrow ends at zero, and the next round opens after a short pause.

A round with no bets is voided — nothing happened, and no ledger entry is written.

## 2. The multiplier curve

Integers only, at every step. Multipliers are ×100 (250 is 2.50×).

```
tick        = 100 ms
m(0)        = 100                                   (1.00x)
m(n + 1)    = m(n) + max(1, floor(m(n) × 10 / 1000))   (+1% per tick, +1 minimum)
```

The curve advances on whole ticks; time within a tick buys nothing. There is no floating
point anywhere in it, deliberately: `Math.pow` is not guaranteed bit-identical across
platforms, and a curve that rounded differently on two machines would settle the same round
two different ways.

The multiplier is capped at **100.00×** (`maxMultiplierX100`, per-tier config).

## 3. The crash point

```
h          = sha256(serverSeed)
r          = first 8 hex digits of h, as an integer in [0, 2^32)
crash×100  = floor((10000 − houseEdgeBps) × 2^32 / (100 × (2^32 − r)))
             clamped to [100, maxMultiplierX100]
```

This is the standard `1/(1−u)` crash distribution with the house edge applied as an
**explicit factor**. `houseEdgeBps` is a disclosed number (300 = 3%), not something folded
into the shape of the curve — the edge is stated, not hidden.

With a 3% edge: the median round crashes just under 2×, and roughly 3% of rounds clamp to
1.00× — an *instant bust*, where the round crashes before anyone can cash out. That is
where most of the edge is actually taken. **The house has a mathematical advantage on every
round. Provable fairness does not change that, and nothing in this product may imply
otherwise.**

## 4. Cashing out

A cash-out carries no multiplier — there is no field for one. The server prices it:

```
elapsed        = (server clock now) − (server clock at lift-off)
multiplier×100 = m(floor(elapsed / 100 ms))
payout         = ceil(stake × multiplier×100 / 100)
```

The payout rounds **up**, in the house's disfavour, per the platform's rounding policy
(`docs/04-security/financial-security.md §11`). At most one minor unit is ever involved, and
it always goes the same way.

If that multiplier has already reached the crash point, the cash-out is **refused** and the
bet is a losing ride. This comparison — not the crash timer — is the authority: a timer
that fires late cannot turn a loss into a win, and a client displaying 4.10× cannot cash out
at 4.10× unless the server's own arithmetic agrees.

The multiplier your screen shows is drawn from the curve parameters the server sent. It is a
picture. Latency is a real property of the game: your cash-out is priced when it reaches the
server, and the curve is identical for everyone in the round.

**Auto cash-out.** An optional target set when the bet is placed, honoured server-side. You
lock in the first tick at or above your target — so a 2.00× target pays at whatever the
curve's next step is, which may be 2.01×, never below 2.00×. If the round crashes before
reaching it, the bet loses. This is also the disconnect policy: **bets stand, and a
disconnected player with an auto target is paid by arithmetic, without anything having to
reach them.** Without a target, a bet rides until the round crashes.

## 5. Verifying a round yourself

1. Note the `commitment` shown while betting is open.
2. After the round, take the revealed `serverSeed`.
3. Check `sha256(serverSeed)` equals the commitment. If it does, the server had fixed this
   outcome before any bet was placed.
4. Recompute the crash point with the formula in §3 and confirm it matches the round's.

**What this proves and what it does not.** It proves the outcome was not chosen after seeing
the bets. It does not make the game favourable, does not affect the house edge, and says
nothing about any other round. A verifier UI is P19+; the data is in the round payload today.

## 6. Limits (per stake tier, configuration)

| Setting | Meaning |
|---|---|
| `betMin` / `betMax` | bet bounds in integer minor units |
| `maxRoundStake` | total stake one round will accept |
| `maxHouseExposure` | worst case the house carries beyond escrowed stakes |
| `bettingWindowMs` / `interRoundMs` | window length and the pause between rounds |
| `houseEdgeBps` | the disclosed edge, 300 = 3% |
| `maxMultiplierX100` | the cap, also the worst-case payout multiple |

Exposure is checked inside the transaction that takes the bet, so two simultaneous bets
cannot both slip past the cap. A refused bet takes no money.

Current values are `TST` (test credits) only, in migration `0007_crash.sql`. Real-currency
values are a P18 concern and will not be these.

## 7. Fairness, audit and disputes

- The seed and crash point exist only server-side until the round ends; `playerView` and
  `publicView` are the only paths to a client and neither carries them before the reveal.
- Other players' bets and cash-outs are public by design — a social game shows you who is
  still riding. Auto-cash-out targets are **not** public: they are a plan, not a decision.
- The full round is in the event log with its RNG draws and clock reads, so any round can be
  replayed exactly as it was played. That is what a dispute is answered from.
- RNG certification (ADR-016, blocked on OQ-01) applies to this game's draw path before real
  money (P18). Nothing here is certified today, and no copy may say it is.

## 8. Kill-switch

`game.crash.enabled` OFF: the round in flight finishes and settles normally, no new bets are
accepted, and no further round opens. Pulling the switch never strands a stake in escrow
(rule 16).
