# ADR-026 — Enforcement at the money boundary

**Status:** ACCEPTED (2026-08-23) · **Phase:** P10 · **Related:** ADR-008 (double-entry ledger), ADR-018 (fraud/risk engine), ADR-025 (table-scoped escrow), `docs/02-domains/responsible-gaming.md`, `docs/02-domains/fraud-risk.md`

## Context

P10 adds two systems that can say **no** to a player: responsible gaming (limits the player
set for themselves, cool-offs, self-exclusions, reality checks) and the risk engine (a score
and a ladder of restrictions ending in a freeze). Both are only worth having if they bind on
*every* path that moves money or starts play — a limit with one way around it is not a
limit, and a self-exclusion with one way around it is a regulatory finding.

The obvious implementation is a check at each entry point: the funding controller, the
matchmaking join, the Crash bet, the poker sit-down. It works on the day it is written. The
problem arrives later, in the form of a game nobody has written yet, added by somebody who
never read this document, who copies an existing game and does not know there was a line to
copy. Nothing fails. No test goes red. The hole is invisible precisely because the
enforcement is invisible — a missing `if` looks exactly like code that was never needed.

The platform already has eleven modules and expects many more games. "Every future author
remembers a rule" is not a control; it is a hope with a good track record until it doesn't
have one.

## Decision

**1. RG and risk checks live inside the wallet's debit paths.** `addFunds`, `buyIn` and
`sitDown` each ask both systems before money moves — not the controllers, not the games.
Every game moves money through the wallet already (rule 10: games never touch wallets), so
this places the check on the one road they all take.

**2. Play *entry* is checked separately, where entry happens.** Reality checks and
exclusions must also stop a player joining a queue or sitting down before any money moves,
so `checkPlayEntry` is called by matchmaking and by poker's sit. This is the one check a
caller can forget — and the failure is bounded, because the wallet still refuses the money
a moment later. Entry checks improve the *message*; the money boundary is what makes them
unnecessary for safety.

**3. RG is consulted and metered inside the caller's transaction.** `checkAllowance` takes a
`PoolClient`. Usage read outside the transaction could be stale by the time the debit
commits; usage written outside it could survive a rollback and charge a player allowance for
a spend that never happened.

**4. Idempotency is resolved before the limit, not after.** A replayed operation posts
nothing, so it consumes no allowance. Checking the limit first meant a retried buy-in — the
same call, after a dropped response — was refused by a limit it had never spent, so the
worse a player's connection, the smaller their limits effectively became.

**5. Risk is checked before the transaction; RG inside it.** A frozen account is a standing
refusal with nothing to keep consistent, so it fails fast. A limit is arithmetic over usage
that the same transaction is about to change.

**6. Emitters push signals into risk; risk reads nobody's tables.** `auth`, `wallet` and
`poker` report facts (a session, a funding velocity, a hand's chip movement). Weights, TTLs
and client-only status come from `risk.rules` — never from the emitter, because the clients
reporting hardening signals are exactly the ones that may be compromised.

**7. Games learn nothing about either system.** No game imports `RgService` or
`RiskService`. A game that cannot see the rule cannot fail to apply it.

## Alternatives considered

- **A check at every entry point.** The default, and the one this ADR exists to reject.
  Correct on day one, and quietly wrong the first time a game is added by someone who has
  not read this file.
- **A NestJS guard or interceptor on the HTTP layer.** Catches controllers and misses
  everything else: the round loop, the matchmaking sweeper, the poker deal loop and any
  future scheduled job move money without an HTTP request in sight.
- **Database triggers on `wallet.ledger_entries`.** The strongest possible enforcement, and
  unusable: the limit that applies depends on *why* money is moving (a deposit limit for
  funding, a wager limit for a stake), which the entries do not carry, and a trigger cannot
  produce the player-facing explanation a refusal needs.
- **A policy service every module must call.** Same shape as the per-caller check, one
  indirection further from the money, and with the added illusion of centralisation.

## Consequences

**Good.** A game cannot forget a rule it never knew about. Adding a game adds no RG or risk
surface area at all. One place to audit for "can this be bypassed", and one place to change
when a jurisdiction adds a rule (P15/P18). Refusals are consistent — the same limit produces
the same message whichever game asked.

**Costs.** The wallet depends on two more modules, and its debit paths are no longer purely
about money. A refusal surfaces to a game as an exception from a wallet call rather than as
a decision the game participated in, so every game must handle a debit that legitimately
fails — which they already must, for insufficient funds. Entry checks are duplicated in
matchmaking and poker for message quality, and that duplication is the part that will need
watching as games are added.

**Not changed.** Games never touch wallets or the ledger. Money remains integer minor units
in a double-entry, append-only ledger. Every financial operation stays atomic, idempotent
and concurrency-safe. The client is still trusted with nothing: every check here is
server-side, and the app's own confirmation friction is courtesy on top of a server that
asks for the same confirmation again.
