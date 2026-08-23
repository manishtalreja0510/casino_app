# End-to-End Testing (device level)

The thin top of the pyramid ([testing-strategy.md §1](./testing-strategy.md)): a small, stable catalog of user journeys on real devices against a real full stack. E2E exists to prove the *assembled* system — app build, flavor config, pinning, WS path through WAF, updater — not to re-prove logic.

## 1. Tooling & targets

- **Flutter `integration_test`** driving the staging-flavor app on an **emulator matrix** (CI: pinned API levels spanning min-supported → latest) plus **at least one physical-device lane** (real Keystore, real network stack, real installer behavior — things emulators approximate). Physical lane runs nightly/release; emulator matrix runs nightly.
- **Target environment: staging** — full-stack (WAF, pinning with staging pins, Redis adapter, multi-instance), mirroring prod topology per `docs/07-operations/environments-and-flavors.md`. Local compose covers the lower integration layer ([integration-testing.md §5](./integration-testing.md)); e2e means staging.
- **Admin browser e2e: Playwright** against `apps/admin` on staging, from P12.
- **Bot clients** for multi-player journeys: the same custom Node Socket.IO harness used for load tests ([performance-testing.md §2](./performance-testing.md)), run in scripted-persona mode.

## 2. Core journeys catalog

| # | Journey | Phase available | Lane |
|---|---|---|---|
| E1 | signup → login → faucet claim → balance visible → transaction history correct | P4 | emulator + device |
| E2 | Casino game round: join via lobby → play round → settlement reflected in balance | P8 | emulator + device |
| E3 | Poker hand, 6-handed: **5 headless bot clients + 1 real device**; blinds→betting→showdown; pots/rake-off correct; device sees only own hole cards | P9 | device + bots |
| E4 | Disconnect/reconnect mid-hand: kill app network mid-betting-round → reconnect within grace → resume via seq replay, hand continues; beyond grace → sit-out/auto-fold per policy | P9 | device + bots |
| E5 | Forced-update lockout: below-min-version build → hard-block screen with update path; no authenticated endpoint reachable | P13 | device |
| E6 | Self-exclusion enforcement: self-exclude → matchmaking, faucet, and game join blocked immediately; state survives re-login | P10 | emulator |
| E7 | Admin critical paths (Playwright): 2FA login → user search/suspend → kill-switch toggle → risk-queue action → audit entries present | P12 | browser |
| E8 | Update-channel e2e: install previous release APK → in-app updater prompts → checksum + manifest signature verified → install new version → app healthy | P13, **run per release** | device |
| E9 | New-device login notification delivered in-app (and via the push transport where available — FCM per OQ-09 recommendation) | P11 | emulator |

Catalog grows only by phase-plan decision; every journey maps to a roadmap acceptance criterion. KYC/deposit/withdrawal journeys join at P16/P17 (against provider sandboxes; fake-provider versions exist earlier on staging per [integration-testing.md §8](./integration-testing.md)).

## 3. Multi-client orchestration

Multiplayer journeys need N participants, but only one needs to be a real device. **Bot clients = the Node Socket.IO harness** in persona mode: each bot authenticates as a synthetic user (factory-seeded), follows a scripted persona (`caller`, `raiser`, `folder`, `disconnector`, `slow-actor`) with deterministic decisions off a seed. The orchestrator seeds users/wallets, spins bots, admits the device under test to the same table, and asserts on both the device (integration_test) and bot-observed events (server truth cross-check). Same harness, same protocol code as load testing — one client implementation to maintain, exercised constantly.

## 4. Flake control

- **Hermetic staging data**: each run seeds its own namespaced users/tables via the factory-based seed job and tears them down after; runs never share accounts; parallel runs are namespace-isolated. No assertions on global staging state.
- **Retry policy**: one automatic retry per journey; pass-on-retry is recorded as a flake event (dashboarded), not silently green. Two consecutive flaky nights ⇒ quarantine + issue per [testing-strategy.md §9](./testing-strategy.md).
- Condition-based waits only (no sleeps), server-event-driven synchronization via a test hook channel; generous single timeout budget per journey rather than per-step tuning.
- Staging deploys pause the e2e schedule (no testing through a rollout).

## 5. What e2e does NOT cover

- **Visual polish** — nothing pixel-level before P19 (placeholder theme is deliberately plain; system-rule 27). Component visuals are golden-tested in `ui_kit` ([unit-testing.md §2](./unit-testing.md)); post-P19 any visual e2e additions are decided in that phase plan.
- **Exhaustive game logic** — hand rankings, side pots, payout math, edge-case action legality are unit/property territory ([unit-testing.md §1](./unit-testing.md)) and conformance-suite territory ([integration-testing.md §6](./integration-testing.md)). E2E plays *representative* hands, not the state space.
- **Load/latency** — [performance-testing.md](./performance-testing.md).
- **Adversarial protocol behavior** — hostile-client suites live at the integration layer where they can be precise.
