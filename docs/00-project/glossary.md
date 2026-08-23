# Glossary

Terms exactly as used across `docs/`. When a doc conflicts with this glossary, fix the doc.

## Money & ledger

| Term | Definition |
|---|---|
| Ledger | The double-entry, append-only record of all money movement in PG (`ledger_transactions` + `ledger_entries`); sole financial truth (ADR-008). |
| Transaction (ledger) | One atomic financial operation (`ledger_transactions` row): unique idempotency key, type, refs; its entries sum to zero. |
| Entry | One signed BIGINT amount against one account within a transaction (`ledger_entries` row). |
| Account | A ledger balance holder: per-user wallet per currency, or house account (`house_main`, `rake`, `bonus`, `match_escrow`). |
| Balance | Cached, versioned derivation of an account's entries (`balances`); never independent truth. |
| Escrow | Per-match holding account (`match_escrow`); buy-ins move in at match start, everything moves out at settlement (zeroes-out invariant). |
| Settlement | Engine-applied payout of a finished match: escrow → winners + rake → house, idempotent by match id; games never do this themselves. |
| Reversal | The only correction mechanism: a new transaction negating a prior one; ledger rows are never updated or deleted. |
| Idempotency key | Client/server-supplied unique key on every mutating financial op (and `Idempotency-Key` REST header); replay of the same key is a no-op. |
| TST | The test-currency code (test credits). All gameplay pre-P18 runs on TST; faucet-funded, no monetary value. |
| Minor units | All money as integer smallest-denomination BIGINT + CHAR(3)-ish currency code; floats/decimals forbidden. |
| Reconciliation | Scheduled jobs proving ledger invariants (sum-zero, balance drift, escrow vs open matches, later PSP statements); drift pages a human and freezes scope. |

## Games & play

| Term | Definition |
|---|---|
| Game | A game *type* (poker, casino game #1): a module implementing `GameDefinition`, registered with the game-engine. |
| Match | One engine-managed instance of a game with an escrow and lifecycle created→starting→in_progress→settling→settled\|voided; the settlement unit. |
| Table | A persistent poker-style venue players sit at; one table hosts many hands; browsable in the lobby. |
| Seat | One player position at a table; reserved with a TTL, bound to buy-in on sit. |
| Hand | One deal-to-showdown round of poker at a table; the poker recovery/void unit. |
| GameDefinition | The TS contract every game implements (ADR-009): `meta`, `init`, `reduce`, `onTimeout`, `playerView`, `isTerminal`, `settle`. |
| reduce | The server-side pure-ish reducer `(ctx, state, action) → {state, events[]}`; validates every action; the only way game state changes. |
| playerView | Per-player projection of game state; the contract-level enforcement point for information hiding (hole cards never leave it to non-owners). |
| ctx | Engine-provided context to game hooks: audit-logged CSPRNG (`ctx.rng`), clock, logger, match metadata. |
| game_events / game_snapshots | Append-only PG event log + periodic snapshots; source of truth for recovery and disputes; Redis holds only hot copies. |
| Void | Terminal outcome when a match/hand cannot be recovered: stakes returned via reversal, audit-logged. |
| Coin-duel | Internal dev-only P6 reference game exercising every contract hook; test fixture, never shipped. |

## Identity, sessions, devices

| Term | Definition |
|---|---|
| Session | Server-side authenticated login context in PG (device, IP, geo, risk flags), Redis-cached, revocable; outlives connections. |
| Connection | One live Socket.IO socket; a session may have zero or many over its life; authenticated via WS ticket. |
| Device | A registered installation identified by an Android Keystore-backed keypair; signs sensitive REST requests. |
| WS ticket | Short-lived one-time token obtained via REST and exchanged at Socket.IO handshake; binds connection to session+device. |
| KYC L0 / L1 / L2 | Verification tiers: L0 none (test currency only); L1/L2 increasing verification depth with limits per jurisdiction config (OQ-01/03). |

## Real-time protocol

| Term | Definition |
|---|---|
| seq | Monotonic per-room sequence number on every server WS event; clients detect gaps/duplicates with it. |
| resume | Reconnect flow: re-auth + `resume(matchId, lastSeq)` → replay missed events, else full `playerView` resync. |
| Ring buffer | Redis-held per-room replay window (~2 min) of recent events serving resume. |

## Platform & operations

| Term | Definition |
|---|---|
| Compliance gate | `compliance.real_money_enabled`: DB-backed master flag, default OFF, four-eyes change; every real-money path sits behind it (rule 11). |
| Kill-switch | Server-side off switch: global maintenance, per-game, per-feature, and the compliance gate; must be drilled, not decorative. |
| Four-eyes | Two distinct authorized admins must approve an action (compliance-gate change, large adjustments) before it applies. |
| Forced update | Server min-version policy per flavor; below-min clients get a 426-style block + update path; the security patch channel for an off-store app (rule 17). |
| Flavors | The three Flutter build variants dev/staging/prod (distinct applicationId suffixes, icons, endpoints, signing keys) matched 1:1 to backend environments. |
| Feature flag | DB-backed, Redis-cached runtime toggle; lookups fail closed. |
| Audit log | Append-only, hash-chained PG table of every sensitive action (money, auth, admin, voids, flag changes); no PII/secrets. |
| Signed manifest | The release metadata file (versions, APK SHA-256 checksums) signed by us and verified by the app against a pinned key before any install prompt. |

## Risk & responsible gaming

| Term | Definition |
|---|---|
| Risk signal | One ingested observation (root/hook detection, velocity, device/IP graph edge, gameplay stat, Play Integrity verdict per OQ-12). |
| Risk score | Rule-derived aggregate per user/session from signals. |
| Risk action | The engine's response: allow / flag / limit / review / freeze; client-side signals degrade/flag, never hard-block. |
| Self-exclusion | Player-initiated indefinite/long-term lockout (account state); blocks matchmaking, faucet, and later deposits immediately. |
| Cool-off | Short player-initiated break, same enforcement path as self-exclusion. |
| Reality check | Periodic in-play interruption showing time/stake spent, at configurable intervals. |

## UI

| Term | Definition |
|---|---|
| Tokens | Design token set (color/typography/spacing/radius/motion) in `ui_kit`; the only source of style values (rule 25). |
| ui_kit | Flutter package holding tokens, theme, and all shared widgets; every screen composes it exclusively. |
| Asset registry | Generated index in `apps/mobile/packages/assets`; final names now, placeholder files until P19. |
| Animation wrapper | Intent-named widget (`CardDealAnimation`, …) hiding the animation implementation so Rive/Lottie swaps never touch call sites. |
| Kitchen sink | Dev-only screen rendering every ui_kit component; P2 acceptance artifact. |

## ID conventions

| Convention | Meaning |
|---|---|
| OQ-nn | Open question in `open-questions.md`; stable, never renumbered; new ambiguity gets the next free number. |
| ADR-nnn | Architecture decision record in `docs/decisions/`; status ACCEPTED, or PROPOSED when blocked on a named OQ. |
| P-nn (P0–P20) | Roadmap phase per `docs/MASTER_ROADMAP.md`; canonical numbering. |
| REQ-XXX-nn | Requirement in `product-requirements.md`, XXX = domain code. |
| A-nn | Recorded assumption in `assumptions.md`. |
