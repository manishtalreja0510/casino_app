# ADR-025 — Table-scoped escrow and table-banked settlement

**Status:** ACCEPTED (2026-08-23) · **Phase:** P9 · **Related:** ADR-008 (double-entry ledger), ADR-023 (open-roster matches), ADR-024 (house-banked settlement), `docs/02-domains/poker.md §5`, `docs/02-domains/wallet.md`

## Context

Every money model so far has been scoped to a **match**. A player buys in, the escrow holds
the stakes, the match settles, the escrow empties. That is true of a coin-duel, and true of
a Crash round: the match is the unit of both play and money.

Poker breaks it. A hand is a match — it has its own event log, its own RNG draws, its own
recovery — but the chips do not belong to the hand. They belong to the **seat**, and they
persist across hands: you sit down with a stack, play twenty hands, and stand up with
whatever is left. Between hands there is no match at all, and the chips still exist.

Forcing that into per-match escrow means one of two bad things. Either every hand pays every
stack out to the wallet and takes it back in for the next hand — dozens of ledger
transactions per player per hour, all of them describing money that never left the table —
or the chips live outside the ledger entirely, which means they are not backed by anything
and "the table has 300,000 chips on it" becomes a claim nobody can check.

There is a second problem underneath. `WalletService.settle` requires payouts to equal
escrow, and `settleHouseBanked` lets the house balance the difference. A poker hand fits
neither: the winner's chips are *already in the account they will be paid from*. The right
number of ledger entries for a hand of poker is zero — except for rake, which does leave.

## Decision

**1. Escrow is scoped to the table, not the hand.** A new `table_escrow` account type, keyed
by `table_id`. Money enters on sit-down (`wallet → table escrow`), leaves on stand-up
(`table escrow → wallet`), and does not move in between.

**2. Chips are game state, backed by that escrow.** The invariant that makes this safe, and
that reconciliation checks:

```
table escrow balance  ==  Σ seated stacks  +  chips in the pot of any hand in progress
```

`poker.seats.stack` is a **cache** of that state, updated when a hand settles. During a hand
the truth is the hand's event log, which is append-only and replayable — so if the cache and
the log ever disagree, the log wins and the disagreement is an incident.

**3. A third banking mode: `GameMeta.banking = 'table'`.** The engine posts no payouts for
such a match. It asks the game one question instead — `rakeFor(ctx, state)` — and posts
exactly that from the table escrow to the house `rake` account. Rule 10 holds: the engine
moves the money, never the game. A table-banked game that returns payouts, or that cannot
say what the house takes, fails the conformance suite.

**4. Seat sessions are the idempotency scope.** Every seat gets a `seat_session_id` at
sit-down, and both the buy-in and the cash-out key on it. A retried sit-down seats and
charges once; a stand-up racing a timeout pays once.

**5. Rake is built from day one and configured to zero on `TST`.** The mechanism — capped
percentage, no flop no drop, side-pot-aware, deducted proportionally — is exercised by
every hand the test economy plays. What it is *set to* is a business and jurisdiction
decision that does not exist yet (P15/P18). Building it later would mean changing the
settlement path of a live game.

## Alternatives considered

- **Per-hand escrow with pay-out-and-buy-back.** Correct but absurd: a six-handed table at
  60 hands an hour would write ~720 ledger transactions an hour describing money that never
  moved. It also makes the ledger useless for the question anyone actually asks of it
  ("what did this player win today"), because every hand looks like a full cash-out.
- **Chips outside the ledger entirely**, reconciled only at stand-up. Cheapest, and the one
  option that fails rule 4's spirit: chips would be numbers in a game table with no
  double-entry record, and a bug in the poker module could create them.
- **Reusing `match_escrow` with the table id in `match_id`.** Saves a column and lies in the
  schema. The next person to read it would reasonably assume that column references a match.
- **A `table` banking mode that pays stacks out per hand.** Ledger-heavy as above, and it
  would make "your stack" a wallet balance — meaning a player could spend chips that are
  sitting on a poker table, from another screen, mid-hand.

## Consequences

**Good.** A hand of poker writes zero or one ledger transactions instead of a dozen. Stacks
are backed by a real, checkable balance rather than by trust in the game module. The
invariant is a single equation that reconciliation can assert after every hand. Adding
another game with persistent state (a tournament, a persistent-world game) needs no new
money model.

**Costs.** A third settlement path to keep correct. The escrow invariant now spans two
modules — the wallet holds the money and the poker module holds the seats — so a bug in
either shows up as drift rather than as a failed transaction; that is why it is reconciled
rather than merely assumed. Table escrows are long-lived accounts, so an abandoned table
holds a non-zero balance indefinitely until it is closed (table closing is P12's).

**Not changed.** Double-entry, append-only, zero-sum per transaction. Idempotency on every
money path. The rule that games never touch wallets. Per-match escrow remains the model for
every game whose money begins and ends with the match.
