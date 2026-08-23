# Game Security

Fairness and game-integrity controls. Engine design: `../02-domains/game-engine.md` (ADR-006/009); RNG decision: ADR-016 (PROPOSED — certification lab depends on OQ-01); poker specifics: `../02-domains/poker.md`; casino game #1: `../02-domains/casino-game.md` (OQ-05, Crash recommended). Threat rows: `./threat-model.md` TB1 (tampering/info-disclosure/collusion), rank 4/7/10.

Two properties are defended here: **outcomes are unpredictable and unbiased** (RNG integrity, A4) and **hidden information stays hidden** (A3). Everything else — money — is `./financial-security.md`.

## 1. Server-side CSPRNG only

- All randomness affecting outcomes is drawn **server-side** from a CSPRNG (`crypto.randomBytes`-class / kernel CSPRNG). Never `Math.random`, never seeded PRNGs for outcomes, never client-influenced entropy (client input may *select* but never *generate* — e.g. a client "pick a card" index maps into an already-shuffled server deck).
- Unbiased range mapping (rejection sampling — no modulo bias); helpers provided by `RngService` so games can't hand-roll it wrong.
- Property tests: distribution sanity on the helpers; forbidden-API lint (no `Math.random` in game modules).

## 2. RngService port & draw audit

All draws flow through the `RngService` port on `ctx.rng` (games cannot import randomness any other way — conformance-tested):

- **Every draw is audit-logged:** draw id (UUIDv7), match id, game code+version, **purpose** (e.g. `deck_shuffle`, `crash_point`), timestamp, and a **value commitment** (hash of the drawn value/sequence — the raw value itself lives in `game_events` where it becomes public at reveal, and only its commitment in the audit trail where it must not pre-leak).
- Enables **post-hoc verification**: any dispute or regulator query replays the match from `game_events` and checks every outcome against the logged draws; commitments prove the draw wasn't rewritten after the fact (append-only + hash-chained audit, rule 15).
- Draw audit completeness is a P6 conformance test: a game that produces an outcome without a logged draw fails CI.

## 3. Certified RNG path (ADR-016)

- Most plausible licenses (OQ-01) require **GLI-19-style certification** of the RNG **including the shuffle algorithms** that consume it — scope is "RNG + its use", not the generator alone.
- Design consequence, in place from P6: the certified module **slots behind the `RngService` port** — swapping CSPRNG for a certified implementation (or certifying our implementation) changes zero game code. Shuffle lives in engine-provided helpers (§5) so it sits inside the certification boundary once, not per game.
- Certification executes in P18 (lab chosen with counsel per OQ-01); the audit log (§2) is designed to satisfy the evidence requirements labs and regulators ask for.

## 4. Commit-reveal provable fairness (optional per game)

For games where outcomes can be pre-committed (house-banked rounds — Crash is the worked example, `../02-domains/casino-game.md`):

1. Server generates round seed `S`; **publishes `H = SHA-256(S)` before betting opens** (in the round-open event, logged in `game_events`).
2. Client/public entropy is mixed where the game supports it (e.g. per-round public salt, or client seeds collected pre-commit) so the server provably didn't choose the outcome after seeing bets: `outcome = f(S, public_mix)`.
3. **Post-round reveal:** server publishes `S`; anyone verifies `SHA-256(S) = H` and recomputes the outcome.

Honest framing: commit-reveal proves the server didn't *change* the outcome after commitment; it does not prove the seed generation was unbiased — that's what §1–3 and certification cover. Poker does **not** use commit-reveal at launch (continuous-shuffle reveal schemes add real complexity for weak guarantees in multiplayer hidden-info games); poker fairness rests on §2/§3 audit + certification. Engine ships the commit-reveal helper (P6); each game's doc states whether it's on.

## 5. Poker-specific integrity (`../02-domains/poker.md`)

- **Shuffle:** Fisher–Yates over 52 cards, CSPRNG-indexed via `RngService`, engine-provided implementation. **Full-deck integrity tests:** every shuffle is a permutation (52 unique cards), distribution tests over large samples, no card can be dealt twice in a hand (structural + tested).
- **Hole-card information hiding is protocol-level, not UI-level (rule 2):** the full `GameState` (deck order, all hole cards) exists **only server-side**. Everything serialized to a client passes through `playerView(state, playerId)` — hole cards appear only in their owner's view; **no full-state broadcast exists in the protocol at all**, so there is nothing to intercept.
- **Resync paths audited for leaks:** reconnect/`resume` replay and full-state resync are rebuilt from `playerView`, never from raw state; adversarial tests (P9) drive the resume protocol as a hostile client — requesting others' views, replaying with forged `lastSeq`, joining rooms uninvited — and assert zero hidden bytes in every response. This is the historical failure mode of real poker sites; it gets a dedicated test suite, not a code-review promise.
- **Showdown reveal rules:** cards become public only per poker rules at showdown (or voluntary show), emitted as explicit reveal events; mucked cards are revealed only where the configured table rules say so. Folded hands never serialize.

## 6. Timing-attack considerations

Where a response could reveal hidden state by its timing or shape, responses are **constant-shape**: same fields, same sizes, padded/uniform where cheap (e.g. an action-rejected response must not differ in shape or measurable latency depending on other players' hidden cards; validation order checks public state before anything touching hidden state). We do not claim immunity to fine-grained timing analysis — we remove the coarse channels, keep hidden-state code paths symmetric by construction, and note residual micro-timing as accepted risk (`./threat-model.md` TB1-I). New endpoints that branch on hidden info get a checklist question (`./security-checklist.md §C`).

## 7. Server-side anti-cheat

The server validates every action; the risk engine turns rejection patterns into signals (`../02-domains/fraud-risk.md`):

| Check | Response |
|---|---|
| Out-of-turn / invalid action (illegal raise size, acting on folded hand) | Reject in `reduce()` (contract validation) + emit risk signal — one is a bug/lag, a pattern is a probe |
| Impossible timing (instant complex decisions, sub-human uniform response times) | Bot-likelihood signal; never an outright block (degrade/flag ladder) |
| Action-rate anomalies (24/7 play, multi-table superhuman rates) | Velocity signals → review queue |
| Protocol fuzzing (malformed payloads, forged seq/room ids) | Schema validation at gateway; repeated → signal + WS rate limits |

Clients never enforce rules; the client is a renderer (rule 21) — so a "cheating client" can only *ask*, and every ask is validated.

## 8. Collusion & chip-dumping (summary)

Full treatment: `../02-domains/fraud-risk.md`. Game-side responsibilities: emit the data detection needs — per-hand history exports, table co-occurrence, seat/IP/device correlations, fold-to-raise and transfer-pattern stats; table-join rules deny same-device/same-IP-cluster seating where configured. Detection heuristics v1 land in P10; human review of flagged hand histories is the adjudication path (no auto-confiscation — freeze + review, `../02-domains/fraud-risk.md §5`).

## 9. State rollback protections

- **Append-only `game_events`** is the match's truth (with periodic `game_snapshots`); Redis hot state is a disposable projection. There is no API — engine, admin, or otherwise — that mutates recorded events. **No silent mutations, ever.**
- **Voids are audited events + reversal refunds:** an unrecoverable match/hand voids via an explicit audited action, refunding through ledger **reversal transactions** (`./financial-security.md §1`), stacks restored as of hand start (poker policy per `../02-domains/poker.md`). Rollback of *state* without corresponding *money* reversal is structurally impossible because settlement only reads terminal states.
- Crash recovery = snapshot + event replay; a server crash therefore cannot be leveraged to re-run a favorable outcome — replay is deterministic from logged events and logged draws (§2).

## 10. Game-version pinning for in-flight matches

A match runs to completion (or void) on the **game version it started with** (`meta.version` recorded on the match; engine routes actions to that version's reducer). Prevents: mid-match rule changes (exploitable and unfair), and deploy-time ambiguity about which logic settled a pot. Version retirement drains via kill-switch semantics (§11); conformance suite runs per version. Detail: `../02-domains/game-engine.md §11`.

## 11. Kill-switch drain semantics

Per-game kill-switch (rule 16) is a **drain, not an axe**: new matches/joins blocked immediately; in-flight matches run to natural completion within a bounded drain window; matches exceeding the window (or when the switch is thrown as `immediate` during an active exploit) are **voided with refunds via reversal** — never silently frozen holding player money in escrow. Escrow invariants hold across drain (escrow zeroes via settlement or void). Drain is tested per game (`./security-checklist.md §C`) and drilled in P14. During a suspected game-integrity incident the sequence is: kill-switch (drain or immediate) → preserve `game_events` → investigate from the audit trail → void/refund affected matches explicitly.
