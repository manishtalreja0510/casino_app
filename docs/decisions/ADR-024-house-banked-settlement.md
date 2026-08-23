# ADR-024 — House-banked settlement

**Status:** ACCEPTED (2026-08-23) · **Phase:** P8 · **Related:** ADR-008 (double-entry ledger), ADR-023, `docs/02-domains/wallet.md`, `docs/02-domains/casino-game.md §3`

## Context

Every game through P7 was **pooled**: players are paid out of each other's stakes, so the
total paid can never exceed what escrow holds. `WalletService.settle` enforces exactly
that, and rejecting an over-payment is correct there — it would be money created from
nothing (rule 5).

Crash is **house-banked**. A player who cashes out at 5× is owed five times their stake
regardless of what anyone else lost, and on a good round for the players the house pays out
far more than the round took in. Under the pooled rule every such round would be rejected
at settlement, with the money stuck in escrow and a page for a human.

The wallet already anticipated this: `house_main` is documented as the "house float /
house-banked game counterparty", and the non-negative balance constraint is deliberately
scoped to `user_wallet` so house accounts may run negative by design
(`docs/02-domains/wallet.md §1`, migration `0003_wallet.sql`).

## Decision

**1. Games declare who pays.** `GameMeta.banking` is `'pooled'` (default) or `'house'`. The
engine routes settlement on that declaration; it never branches on a game's code.

**2. `WalletService.settleHouseBanked`.** One ledger transaction: escrow is drained,
winners are credited, and `house_main` takes the difference —

```
houseNet = escrowAmount − Σpayouts
```

positive when the house collected losing stakes, negative when it paid winnings. It is a
**balancing** leg, not a residual one, which is the whole difference from the pooled path's
rake sweep. Everything else is deliberately identical: idempotency is checked *before* any
validation (a retried settlement must find the escrow already emptied and still succeed),
escrow must end at exactly zero, and one transaction covers the whole round.

**3. Exposure is capped before the round runs, not discovered after.** A house-banked game
must declare `meta.maxPayoutX100` — the worst case a player can be owed as a multiple of
their stake. Per tier, configuration then caps total round stake and maximum house
exposure, enforced at bet time inside the join transaction. A game that cannot state its
worst case has no business being house-banked, and the conformance suite fails it.

**4. The house float may go negative, and only it may.** That is what a float is. The
running balance is an operational number: `settleHouseBanked` logs when the house pays out
net, the audit entry for `game.settled` records `banking` and `houseNet`, and P10/P12 turn
those into monitoring and an alert when the realised edge drifts from the configured one —
which is how a wrong payout implementation shows up first.

## Alternatives considered

- **Pre-fund escrow to the worst case.** Escrow would have to hold `Σstake × maxPayout` for
  every round — 100× the stakes at Crash's cap — which is a large idle float and turns a
  single hot account into a settlement bottleneck for no correctness gain.
- **Cap payouts at escrow.** Silently changes the game's rules: a player who cashed out at
  5× would be paid whatever the round happened to hold. Paying less than the published
  odds because of an accounting convenience is not a trade-off worth listing.
- **A per-game house account.** More granular PnL, but every game then needs its own float
  provisioned and monitored. `house_main` with `refType/refId` on each transaction gives the
  same per-game analysis from the ledger. Revisit if contention on the account row bites —
  the shard-and-sum escape hatch is already documented in `wallet.md §1`.

## Consequences

**Good.** House-banked games settle through the same audited, idempotent, single-transaction
path as pooled ones; exposure is a number known before a round starts rather than a surprise
after it; the ledger still balances to zero on every transaction, and reconciliation is
unchanged.

**Costs.** `house_main` needs operational attention (a float that trends down is either bad
luck or a payout bug, and telling those apart needs the metrics in P10/P12); one more
settlement path to keep correct; the exposure cap can refuse a legitimate bet on a busy
round, which is the intended behaviour but is a rejection players will see.

**Not changed.** Double-entry, append-only, zero-sum per transaction. Idempotency by match
id. Escrow ending at zero. Rule 10 — games never touch wallets; only the engine settles.
