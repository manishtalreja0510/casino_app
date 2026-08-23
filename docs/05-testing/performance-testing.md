# Performance & Load Testing

Feeds the **P14 gate** — no real-money phase completes without these results (`docs/MASTER_ROADMAP.md` P14, system-rule "P14 gates P18"). The harness starts life in P5 (load smoke) and matures through P14; re-run on final config in P18.

## 1. Tooling split

| Tool | Covers | Why |
|---|---|---|
| **k6** | REST: auth, wallet, lobby, webhook ingestion, updater/version-check endpoints | Standard scriptable HTTP load, thresholds as code, CI-friendly |
| **Custom Node Socket.IO harness** | All WS: gameplay, resume, matchmaking presence | The Socket.IO protocol (handshake, ack, namespaces, adapter semantics) is not natively supported by k6; a raw-WS driver would bypass the very protocol under test. The harness speaks real `socket.io-client`, executes the real ticket handshake, and **doubles as the bot-client fleet** for multiplayer e2e ([e2e-testing.md §3](./e2e-testing.md)) — one protocol client, always exercised |

Harness capabilities: N virtual players with persona scripts, seq-gap detection, per-event latency capture (server send → client receive, plus server-side action→broadcast from OTel), scripted disconnect/reconnect patterns, deterministic seeds.

## 2. Target scenarios

Baselines below are planning numbers — **tune in P14 plan** against real hardware/topology before they become gate thresholds.

| Scenario | Baseline (tune in P14 plan) | Shape |
|---|---|---|
| WS concurrency | 5k concurrent Socket.IO connections | Ramp + hold; heartbeats + lobby traffic |
| Active tables | 500 concurrent tables/matches | Bots playing real coin-duel/casino/poker matches at realistic action rates |
| Matchmaking storm | 1k joins/min sustained | Queue fill, match formation, seat races — no double-seat, no stuck escrow |
| Reconnect storm | 30% of connections dropped, all rejoining within 60s | Mixed replay-window hits and full resyncs; adapter + ring-buffer stress |
| Settlement burst | Mass simultaneous match settlements (e.g. synchronized round end across tables) | Ledger write path + row-lock contention under spike |
| Webhook burst | Fake-PSP burst incl. duplicates/out-of-order | Idempotent ingestion under pressure |

## 3. SLOs and error budgets

Server-side measured (OTel spans), per scenario at target load:

- **action → state broadcast p95 < 250 ms** (game action received → last room member's event emitted), **p99 < 600 ms** (tune in P14 plan).
- REST p95 < 300 ms non-financial reads; financial mutations p95 < 500 ms (idempotency + locks included).
- WS connect+resume p95 < 2 s during reconnect storm.
- **Error budgets**: < 0.1% failed actions per scenario; **zero** tolerated: ledger drift, duplicate settlement, seq regression/leak, lost acknowledged action. Any zero-class event fails the run regardless of other numbers.

## 4. Soak

**24 h at 60% of peak target** (tune in P14 plan): mixed scenario blend, bots playing continuously. Watching for: memory growth per process (leak detection), FD/socket leaks, Redis memory growth (ring buffers/queues bounded), PG bloat/replication lag creep, latency drift over time, BullMQ backlog stability, reconciliation jobs staying clean throughout. Flat lines or explained curves required to pass.

## 5. Chaos woven in (expected behaviors defined up front)

Run *during* load, not in isolation; each has a pass definition — recovery behavior, never data loss:

| Injection | Expected behavior |
|---|---|
| API/WS instance kill (SIGKILL, one of N) | Clients resume on surviving instances via Redis adapter + resume protocol; in-flight matches recover from snapshot+events or void+refund with ledger intact; zero drift |
| PG failover (primary → replica promotion) | Writes pause ≤ failover budget, then resume; no committed transaction lost, no half-applied settlement (idempotency absorbs retries); reconciliation clean afterward |
| Redis flush mid-play | Gameplay interrupts, **money does not** (system-rule 7): matches recover from PG or void+refund; queues/reservations rebuild; sessions re-establish via PG truth; alarms fire |
| Kill-switch flips under load | Per-game switch drains tables gracefully; maintenance mode returns proper 503 envelope; no stuck escrow |

## 6. DB performance checks

- **Ledger insert throughput**: sustained tx/s ceiling on prod-shaped hardware measured and recorded vs projected peak (settlement burst × safety factor).
- **Partition strategy validation**: `game_events` / audit / ledger partitioning per `docs/01-architecture/database-architecture.md` validated under load — partition pruning in plans, no cross-partition scans on hot paths.
- **Lock contention monitoring**: `pg_locks`/wait-event sampling during bursts; hot-account contention (house accounts, rake) quantified; ordered-lock discipline confirmed (zero deadlocks expected; any deadlock is a bug, not tuning).
- Index/plan review from `pg_stat_statements` top-N; connection-pool saturation behavior at limits.

## 7. Profiling toolkit

OTel traces (action→broadcast spans, cross-service timing), `pg_stat_statements` (+ `auto_explain` in staging), Node profiling of clinic.js class (CPU flame, event-loop delay, heap snapshots for soak leaks), Redis `latency history`/`INFO` tracking, Grafana dashboards (OQ-10 stack) with the SLO metrics as first-class panels — the same dashboards ops uses, so the load test validates observability too.

## 8. P14 gate — pass/fail structure

The P14 phase plan freezes tuned numbers into a gate sheet; structure:

1. **Hard fails (any ⇒ gate closed)**: ledger drift ≠ 0; information leak; seq protocol violation; unrecovered chaos scenario; zero-class error budget breach.
2. **Threshold fails**: any SLO p95/p99 miss at target load; error budget exceeded; soak trend unexplained.
3. **Conditional pass**: threshold miss with a written waiver naming owner, remediation, and re-test date — allowed only for non-money paths, recorded in the phase completion report.
4. Results archived (raw + dashboard snapshots) in the P14 completion report; **P18 re-runs the suite on final config** (real currency accounts, geo-fencing, chosen providers' sandboxes) before `compliance.real_money_enabled` flips.

## 9. Environment rules

- Load tests run against **staging, whose topology mirrors prod** (instance counts/sizes, WAF in path, Redis adapter, PG replica) — numbers from a non-mirror topology don't count for the gate.
- **Never load-test prod.** After launch, capacity validation happens on staging scaled to prod-equivalent shape; prod gets synthetic canary probes only.
- WAF/CDN coordination: load-source IPs allowlisted for the window (results must state whether WAF was bypassed for the scenario — protocol-limit tests deliberately include it).
- **Cost note**: prod-mirror staging at full scale is expensive; it may be scaled to mirror shape only for load windows and shrunk between, provided config parity is scripted (infra-as-code) and the scale-up is part of the test runbook. The P14 plan budgets these windows explicitly.
