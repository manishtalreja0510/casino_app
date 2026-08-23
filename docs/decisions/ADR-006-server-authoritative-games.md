# ADR-006: Server-authoritative game architecture

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

The APK is distributed off-store and will be decompiled, patched, and instrumented — the client is compromised by definition (rule 1 ⛔). Real money rides on every outcome. Any architecture in which the client computes, times, or knows anything decision-relevant hands attackers the game.

## Decision

**The server is authoritative for everything that matters:** all game outcomes, RNG draws, turn order, timers, balances, entitlements, and hidden information. Concretely:

- The client **renders state and sends intents** ("I want to raise 200"); the server's game reducer validates every action against authoritative state (ADR-009) and rejects illegal ones.
- **Timers are server-side only** (engine timer framework / BullMQ delayed jobs); client countdowns are cosmetic. Timeout consequences (auto-fold, forfeit) are computed server-side via `onTimeout`.
- **Hidden information never leaves the server except to its owner**, enforced structurally in `playerView` — hole cards are not in other players' payloads to be "hidden by the UI".
- **Client hardening** (obfuscation, root/hook detection, signature self-check, Play Integrity per OQ-12) is a **cost-raiser feeding the risk engine, never a security boundary or gate**. We never claim "un-reverse-engineerable" (rule 3).

## Alternatives considered

- **Client simulation + server verification** (client computes, server checks/replays). Halves perceived latency but doubles the logic (rule 21 violation), and "verification" drifts into trusting client-computed results under load. For turn-based/round-based games our latency budget doesn't need it. Rejected.
- **Lockstep / P2P between clients.** Standard for RTS games; **rejected outright for money games** — peers see each other's inputs (and with naive dealing, each other's cards), any peer can stall or cheat, and there is no authoritative record for disputes.

## Consequences

**Positive:** cheating requires beating the server, not patching an APK; one implementation of every rule; complete authoritative event log for disputes, refunds, and collusion analysis; hidden-information leaks become structurally hard.

**Negative (accepted):** the server carries all simulation load — every table tick, timer, and validation is server CPU, and WS fan-out scales with players × events (capacity planned in P14); gameplay is latency-sensitive — perceived responsiveness depends on RTT, mitigated by optimistic *rendering* (never optimistic outcomes), regional deployment when needed, and game designs tolerant of 100–300 ms; thin-client discipline must be actively held (review + rule 21) because pushing "just this bit" of logic client-side is always locally tempting; server bugs are total — hence the conformance and adversarial test suites (ADR-010).

## Links

- [system-rules.md](../00-project/system-rules.md) rules 1–3, 21; [threat-model.md](../04-security/threat-model.md)
- [game-architecture.md](../01-architecture/game-architecture.md), [realtime-architecture.md](../01-architecture/realtime-architecture.md), [security-architecture.md](../01-architecture/security-architecture.md)
- ADR-007 (transport), ADR-009 (contract), ADR-018 (risk engine)
- Phases: P5 (timer framework), P6 (engine), P10 (hardening signals), P14 (load)
