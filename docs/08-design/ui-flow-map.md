# UI Flow Map

**The designer onboarding document** and the living catalog of every screen in the app. Seeded during planning; **kept current: any PR that adds/changes/removes a screen updates this doc in the same PR** (system rule 29). At P19 start, this doc + the kitchen-sink screen (`design-system.md §6`) are the designer's complete tour of the product.

Companions: `design-system.md` (tokens/components), `asset-animation-pipeline.md` (assets), `docs/01-architecture/*` (what's behind the screens), `docs/MASTER_ROADMAP.md` (phase meanings).

## How to read this doc

- Screens are grouped by **flow**. Each screen lists: **Purpose** · **Entry points** (how you get there) · **States** (every visual state, always incl. loading/empty/error/offline where applicable) · **Key components** (from `ui_kit`) · **Exits** (where you go next) · **Status** (`NOT_BUILT (Pn)` = planned for phase Pn; `BUILT (Pn)` once merged; date the change in the change log).
- Everything is currently `NOT_BUILT` — this is a planning seed. Statuses flip as phases land.
- Screens marked **P16-gated / P17-gated** must not be reachable before those phases; their routes exist in config but resolve to a "not available" guard.
- All screens render the placeholder theme until P19 (rule 27). Nothing here describes visual design — only structure, states, and intent.

## Global navigation model

- **go_router, single central typed route config** in `apps/mobile` (ADR-002). Flow is configuration: reordering/transition changes in P19 are router-config edits, not screen edits.
- **Auth-gated shells:** an unauthenticated shell (onboarding/auth flow) and an authenticated shell; redirect guard on session state (Riverpod). Force-blocking screens (forced update, maintenance, self-exclusion block) are top-level routes that the guard layer can force regardless of location (z-layer + router redirect; rule 17).
- **Authenticated shell structure (placeholder):** bottom navigation with 4 tabs — **Home** (lobby), **Wallet**, **Notifications**, **Account**. Whether this stays bottom-nav or becomes a drawer/other is a P19 flow decision; it's config, not screen logic.
- **Cross-cutting overlays** (not routes): `OfflineBanner`, reconnecting overlay (in-game), update-available prompt, toasts.

---

## Flow: Onboarding / Auth (P2–P3, P13)

| Screen | Detail |
|---|---|
| **Splash / version check** | Purpose: boot, config fetch, min-version check, session restore. Entry: app launch. States: loading; update-required → forced-update screen; maintenance → maintenance screen; error(retry). Components: `LoadingState`. Exits: login (no session) / home (session) / block screens. Status: NOT_BUILT (P2 shell; version-check enforcement P13). |
| **Signup** | Purpose: account creation (email+password). Entry: splash, login link. States: idle; validating(client UX only — server revalidates, rule 21); submitting; field errors; server error; offline. Components: `AppInput`, `AppButton`, `AppToast`. Exits: home (auto-login) / login. Status: NOT_BUILT (P3). |
| **Login** | Purpose: authenticate. Entry: splash, signup link, session expiry. States: idle; submitting; invalid-credentials; rate-limited/lockout (server-driven message); offline. Components: `AppInput`, `AppButton`. Exits: home / signup. Status: NOT_BUILT (P3). |
| **Device trust** | Purpose: register device-bound keypair on first login on a device (`docs/02-domains/authentication.md`); shows new-device notice. Entry: login on unregistered device. States: registering; success; failure(retry). Components: `LoadingState`, `AppDialog`. Exits: home. Status: NOT_BUILT (P3). |
| **Forced-update block** | Purpose: hard-block below-min-version clients with update path (rule 17 ⛔). Entry: version check, 426-style API response — reachable from anywhere via guard. States: default; downloading(progress); checksum/signature-verify failure; install handoff. Components: `AppButton`, `EmptyState`-style layout. Exits: none except update. Status: NOT_BUILT (P2 static screen; full updater P13). |
| **Maintenance / kill-switch** | Purpose: global-maintenance or per-feature kill-switch notice. Entry: guard on 503 envelope / flag state, from anywhere. States: full-block (global); scoped (per-game — shown in-context, see game flows); retry. Components: `EmptyState`, `AppButton`. Exits: retry → previous location. Status: NOT_BUILT (P2 static; wired P5+). |

## Flow: Lobby (P7–P9)

| Screen | Detail |
|---|---|
| **Home / game select** | Purpose: entry hub; pick a game. Entry: shell tab 1, post-login. States: loading; loaded (game cards incl. per-game kill-switch "unavailable" state); empty (all games off); error; offline. Components: `AppCard`, `AppBadge`, `BalanceDisplay` (header), `EmptyState`. Exits: game lobby, wallet, account. Status: NOT_BUILT (P7). |
| **Game lobby** | Purpose: per-game staging — queue join (casino game) or table list (poker). Entry: home. States: loading; queue-mode (stake tiers via `StakeSelector`, insufficient balance); table-list mode (tables w/ stakes/seats, empty, full-table); joining/reserving seat; reservation expired; error; offline; game killed. Components: `StakeSelector`, `AppListTile`, `AppCard`, `AppButton`. Exits: matchmaking wait / game screen / poker table (seat reserved). Status: NOT_BUILT (P7; poker table list P9). |
| **Matchmaking wait** | Purpose: in-queue state. Entry: game lobby join. States: searching (elapsed time); match found (transition); cancelled; timeout(re-queue offer); error; offline (queue exit warning). Components: `LoadingState`, `CountdownTimerRing`, `AppButton` (cancel). Exits: game screen / back to game lobby. Status: NOT_BUILT (P7). |

## Flow: Wallet (P4; P17-gated parts)

| Screen | Detail |
|---|---|
| **Balance & history** | Purpose: wallet home — balance + transaction list. Entry: shell tab 2, `BalanceDisplay` taps. States: loading; loaded; empty history; paging(cursor); error; offline(stale-data indicator). Components: `BalanceDisplay`, `AppListTile` (transaction variant), `EmptyState`, `AppTabBar`. Exits: transaction detail, faucet, deposit/withdraw (gated). Status: NOT_BUILT (P4). |
| **Faucet (test currency)** | Purpose: claim `TST` credits, with limits (`docs/02-domains/wallet.md`); dev/staging tool that exercises real credit rails. Entry: wallet home. States: available; claiming; claimed(cooldown countdown); limit-reached; RG-blocked (self-excluded); error. Components: `AppButton`, `CountdownTimerRing`, `AppToast`. Exits: wallet home. Status: NOT_BUILT (P4). |
| **Transaction detail** | Purpose: single ledger transaction view (type, entries, refs, match link). Entry: history row. States: loading; loaded; error. Components: `AppListTile` (value variant), `AppCard`. Exits: related match result (if game tx). Status: NOT_BUILT (P4). |
| **Deposit** — **P17-gated** | Purpose: real-money deposit via PSP (OQ-02). Entry: wallet home (hidden until `compliance.real_money_enabled`). States: TBD in P17 phase plan (intent → PSP redirect/SDK → pending → result). Status: NOT_BUILT (P17). |
| **Withdraw** — **P17-gated** | Purpose: payout flow incl. KYC-gate and review states. Entry: wallet home (gated as above). States: TBD in P17 (KYC-required, amount entry, pending-review, processing, paid, failed). Status: NOT_BUILT (P17). |

## Flow: Game (P8–P9)

| Screen | Detail |
|---|---|
| **Casino game screen** | Purpose: play casino game #1 — shaped by OQ-05 (recommendation Crash), structured as: round state display (`MultiplierCurve` for crash-class), stake controls, history. Entry: matchmaking/lobby. States: round-idle(betting window w/ `CountdownTimerRing`); round-running; round-resolved(win/lose via `WinCelebration`); spectating(joined mid-round); reconnecting(overlay); game-killed(drain notice); error. Components: `MultiplierCurve`, `StakeSelector`, `BalanceDisplay`, `RoundHistoryStrip`, `AppButton`. Exits: leave → game lobby; settlement → match result (or inline). Status: NOT_BUILT (P8). |
| **Poker table** | Purpose: NLHE cash table (OQ-07 rec.). Entry: lobby seat reservation. States: seating(buy-in via `StakeSelector`); playing — per-seat states via `TableSeat` (empty/occupied/self/acting/sitting-out/disconnected); betting turn (`ActionBar` enabled w/ server-provided options+bounds, `CountdownTimerRing`); showdown (`PlayingCard` reveals per server `playerView` — hole cards only ever own+shown-down, rule 2 ⛔); hand-void notice (crash recovery refund); sit-out; stand-up confirm; reconnecting; table-killed. Components: `TableSeat`, `ChipStack`, `PlayingCard`, `PotDisplay`, `ActionBar`, `CardDealAnimation`, `ChipMoveAnimation`, `WinCelebration`. Exits: stand → game lobby (stack settled to wallet). Status: NOT_BUILT (P9). |
| **Reconnecting overlay** | Purpose: in-game connection-loss handling (`docs/01-architecture/realtime-architecture.md` resume protocol); not a route — modal overlay. Entry: WS drop during play. States: reconnecting(attempts); resuming(replay/resync); resumed(flash); failed → exit-to-lobby with server-outcome note (auto-fold/sit-out per game policy). Components: `LoadingState`, `OfflineBanner` styling, `AppDialog` (failure). Status: NOT_BUILT (P5 primitive, wired per game P8/P9). |
| **Match result / settlement** | Purpose: post-match summary — outcome, settlement amounts **from server settlement events only**, ledger reference. Entry: match end. States: loading(settling); settled(win/loss/refund-void); error(settlement pending — never invent numbers client-side, rule 2). Components: `BalanceDisplay`, `AppListTile` (value), `WinCelebration`, `AppButton`. Exits: rematch/re-queue → lobby; wallet history. Status: NOT_BUILT (P8/P9 with each game). |

## Flow: Account (P3+; P16-gated parts)

| Screen | Detail |
|---|---|
| **Profile** | Purpose: identity summary (display name, account state, KYC level badge). Entry: shell tab 4. States: loading; loaded; error. Components: `AppListTile`, `AppBadge`. Exits: settings, RG, KYC, sessions, notifications inbox. Status: NOT_BUILT (P3). |
| **Settings** | Purpose: app prefs (sound/haptics toggles, notification prefs), legal links, logout, app version. Entry: profile. States: loaded; logging-out. Components: `AppListTile` (setting), `AppDialog` (logout confirm). Status: NOT_BUILT (P3, grows later). |
| **RG limits** | Purpose: set deposit/loss/session limits, reality-check interval (`docs/02-domains/responsible-gaming.md`). Entry: profile, RG prompts. States: loading; loaded; editing(decrease immediate / increase delayed — server-enforced, shown as pending); saved; error. Components: `AppInput`, `AppListTile`, `AppDialog`. Status: NOT_BUILT (P10). |
| **Self-exclusion & cool-off** | Purpose: initiate cool-off/self-exclusion; irreversible-action UX. Entry: RG limits. States: choosing(duration); double-confirm; active(blocked-state info — also enforced as account-state guard across app). Components: `AppDialog` (destructive), `AppButton` (danger). Status: NOT_BUILT (P10). |
| **KYC flow** — **P16-gated** | Purpose: identity verification via provider (OQ-03) — provider-SDK-shaped. Entry: profile, withdrawal gate. States: TBD in P16 (start, doc capture, liveness, pending, verified, rejected w/ retry, manual review). Status: NOT_BUILT (P16). |
| **Sessions & devices** | Purpose: active sessions/devices list, revoke one/all (`docs/02-domains/authentication.md`). Entry: profile, new-device notification. States: loading; loaded(current highlighted); revoking; empty(never — current exists); error. Components: `AppListTile`, `AppDialog` (revoke confirm). Status: NOT_BUILT (P3). |
| **Notifications inbox** | Purpose: in-app notification list (critical + informational; `docs/02-domains/notifications.md`). Entry: shell tab 3, push tap. States: loading; loaded(unread badges); empty; paging; error; offline. Components: `AppListTile`, `AppBadge`, `EmptyState`. Exits: deep links to relevant screens. Status: NOT_BUILT (P11). |

## Cross-cutting states (every screen)

| Concern | Handling |
|---|---|
| **Offline** | `OfflineBanner` overlay globally (P2 primitive); screens keep last data with stale indicator; mutations queue only if idempotent, else disabled. In-game → reconnecting overlay instead. |
| **Update available (soft)** | Non-blocking prompt (toast/sheet) when a newer version exists but min-version passes; never interrupts an active hand/round. P13. |
| **Forced update (hard)** | Guard-level redirect to forced-update block from any screen on min-version failure or 426 response. Non-negotiable path (rule 17 ⛔). |
| **Kill-switch / maintenance** | Global → maintenance screen. Per-game → game unavailable states in lobby + in-game drain notice (finish/void per game policy, server-decided). Per-feature (e.g. faucet) → feature-level disabled states. Real-money master gate keeps P16/P17 surfaces hidden entirely. |
| **Session expiry / revocation** | Guard redirect to login with reason toast; in-game handled via reconnect-then-fail path. |
| **Self-exclusion / suspension** | Account-state guard blocks matchmaking/wallet surfaces with explanatory block screen + support path. |

## Change log

| Date | PR | Change |
|---|---|---|
| 2026-08-23 | — | Seeded full planned catalog; all screens NOT_BUILT. |
