# ADR-022 — Interim direct-credit funding (no PSP during development)

**Status:** ACCEPTED (interim — superseded by real PSP integration at P17)
**Date:** 2026-08-23
**Related:** OQ-02 (deferred), ADR-008 (ledger), ADR-014 (payment-provider abstraction, PROPOSED), P4, P17

## Context

No PSP can be selected yet (OQ-02, itself downstream of licensing which a separate team now owns). Development nevertheless needs funded wallets to build and exercise wallet, matchmaking, game settlement, and history.

The owner's decision: **treat payment as static — the user submits an amount and it is credited directly.**

## Decision

Implement a **direct-credit funding path** in the wallet domain (P4):

1. The user submits an amount; the system credits their wallet **through the normal ledger flow** — a double-entry transaction from a dedicated `house_dev_funding` account to the user account, with an idempotency key and an audit entry. Rules 4, 5, 6, 10 and 15 apply unchanged; only the *external money movement* is absent.
2. It is exposed as a wallet operation, **not** as a `PaymentProviderPort` implementation. The port and the deposit/withdrawal state machines described in `../02-domains/payments.md` remain the P17 design; this interim path deliberately does not pretend to be a PSP, so no fake-PSP semantics leak into the real payment model.
3. **Gating (mandatory, non-negotiable):** the path is controlled by the `payments.dev_direct_credit` feature flag, and the wallet service **refuses to execute it whenever `compliance.real_money_enabled` is ON** — the check is a hard invariant in the service, not merely a flag default, and is covered by a test that fails the build if the two can ever be simultaneously true.
4. Per-user and per-period caps apply even on test currency, so risk-engine velocity rules (P10) have a real signal to observe.
5. Currency is `TST` test credits (OQ-08 unchanged). No real currency accounts exist until P18.

## Alternatives considered

- **Build the full deposit state machine against a fake PSP now.** Rejected for the moment: it front-loads P17 design work while the actual PSP semantics (webhooks, settlement files, dispute model) are unknown, and would likely be reshaped anyway. The port stays in the design so this remains cheap to add.
- **Bypass the ledger and set a balance directly.** Rejected outright — it would violate rules 2, 4 and 5, and would mean the wallet's core invariants were never exercised during the phase that exists to prove them.
- **No funding at all; seed balances by migration.** Rejected: gives no runtime path to exercise idempotency, concurrency, or history, which is much of what P4 must prove.

## Consequences

**Positive.** Wallet, settlement, and history are fully exercisable on day one; the ledger invariants get real traffic long before real money; nothing about the eventual PSP integration is prejudged.

**Negative / accepted.** A direct-credit path is, by construction, a "create money" operation — exactly what an attacker would want. It is acceptable **only** because it is test currency, flag-gated, capped, audited, and mutually exclusive with the real-money gate. Before P18 this path must be verified absent-or-disabled as an explicit launch-gate item; that check is recorded in the P18 scope and in the security checklist's release section.

**Reversibility.** Superseded at P17 by the real PSP adapter. The interim path is then removed or permanently disabled — it must not survive as a "convenient" admin tool; admin adjustments have their own audited, four-eyes path (`../02-domains/admin.md`).
