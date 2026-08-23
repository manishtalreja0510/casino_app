# Observability

Stack (OQ-10 recommendation, revisit residency at P15): **pino** structured logs → Loki; **OpenTelemetry** traces/metrics → Prometheus/Grafana (+ OTel collector); **Sentry** SaaS for error tracking (backend + Flutter). Baseline lands **P1** (backend) / **P2** (client), grows per phase; SLOs formalized in **P14**.

## 1. Logging (pino, structured JSON)

Canonical schema (every line):

| Field | Content |
|---|---|
| `ts` | ISO-8601 UTC |
| `level` | trace/debug/info/warn/error/fatal |
| `traceId` / `spanId` | from OTel context — logs↔traces join key |
| `module` | NestJS module (auth, wallet, game-engine, …) |
| `event` | machine-readable event name (`wallet.settlement.applied`) |
| ids | **opaque UUIDs only** — userId, matchId, txId, sessionId, caseId |
| `err` | serialized error (code, message, stack) — no request bodies |

**PII/secret rules (rule 15, ⛔):** no names, emails, documents, tokens, card data, addresses — anywhere, any level. Enforced by: pino redaction config (denylist paths: `authorization`, `password`, `token`, `email`, …) **plus P1 scrub tests** that serialize representative objects through the logger and assert redaction; new sensitive fields must be added to the test fixtures in the same PR. Payload bodies are never logged wholesale.

Verbosity per env: `environments-and-flavors.md` §1.

## 2. Tracing (OpenTelemetry)

- Instrumented: **HTTP** (inbound REST + outbound provider calls), **WS** (Socket.IO event handling spans with namespace/event attrs), **BullMQ** (job spans, linked producer→consumer), **PG** (query spans — statement *names*, never parameter values).
- Propagation: W3C tracecontext; traceId returned in error envelopes for support correlation; client sends a correlation id header, joined server-side.
- Sampling: head-based — 100% errors and money-path transactions (wallet/settlement/payments), ~10% general REST, ~1% high-volume WS gameplay events; tail-sampling at the collector when volume demands. Money paths never sampled out.

## 3. Metrics catalog

**RED per endpoint/event** (rate, errors, duration histograms): every REST route class, every WS event type, every BullMQ queue.

Domain metrics:

| Metric | Type | Notes |
|---|---|---|
| `matches_active{game}` | gauge | |
| `ws_connections{namespace,instance}` | gauge | + connect success/failure counters |
| `queue_depth{queue}` / job age | gauge | BullMQ (matchmaking, settlement, webhooks, reconciliation) |
| `settlement_latency_seconds` | histogram | terminal state → ledger applied |
| **`ledger_drift` = 0** | gauge | from reconciliation: sum-zero, balance-vs-derived, escrow-vs-open-matches. Anything ≠ 0 pages (rule 9) |
| `reconciliation_runs{result}` | counter | missed schedule also alerts |
| `audit_chain_verified` | gauge | periodic hash-chain verification job result |
| `faucet_credits_rate` | counter | abuse visibility (P4/P10) |
| `risk_flags{action}` | counter | allow/flag/limit/review/freeze |
| `rg_events{type}` | counter | limits hit, exclusions started |
| `kyc_cases{state}` / `payment_tx{state}` | gauge/counter | P16/P17 |
| `rtp_actual_vs_theoretical{game}` | gauge | fairness drift (also compliance evidence, `../06-compliance/licensing-requirements.md` §4) |
| update adoption / funnel / `update_required_rejections` | per `distribution-and-updates.md` §7 | |

## 4. Dashboards

| Dashboard | Contents |
|---|---|
| Platform | RED overview, instances, PG/Redis health, job queues, error budget burn |
| Realtime | WS connections/success, resume rates, room counts, event latency, ring-buffer hit rate |
| **Money** | ledger drift, reconciliation, settlement latency, escrow open vs matches, faucet; P17: deposits/withdrawals/PSP webhook lag |
| Per-game | active matches/tables, actions/s, timeouts, void rate, RTP drift |
| Risk & RG | flags by action, review-queue depth/age, collusion alerts, RG events |
| Distribution | version histogram, update funnel, minSupported rejections, manifest errors |

## 5. Alerting policy — page vs ticket

| PAGE (human, now) | Why |
|---|---|
| **Ledger drift ≠ 0** / reconciliation failure or missed run | money truth (rule 9: page + freeze scope) |
| **Audit chain verification failure** | tamper or corruption (rule 15) |
| Kill-switch auto-trigger / real-money gate state change | rule 16; gate flips are always human-verified |
| Error-rate or latency **SLO fast burn** (§6) | player-facing outage |
| WS connect success below floor | gameplay down |
| Cert or **pin expiry approaching** (staged thresholds: 30/14/7d) | botched pinning bricks installs (ADR-013, runbook c) |
| **Forced-update misconfig** (`UPDATE_REQUIRED` spike, §7 of distribution doc) | fleet lockout |
| Manifest signature/verify failure spike | update-channel tamper (runbook f) |
| PG failover, backup failure, WAL archiving stalled | `backup-disaster-recovery.md` |
| Sanctions-hit class risk events | compliance clock may be ticking |

| TICKET (next business day) | Examples |
|---|---|
| everything else | queue-depth trends, adoption stalls, single-instance restarts, dependency-audit findings, RTP drift within bounds, review-queue aging, error-rate slow burn |

Every page maps to a runbook entry (`runbooks.md`); a page without a runbook is itself a ticket to fix.

## 6. SLOs (formalized in P14 plan; feed the load-test targets)

| SLO | Initial target (tune in P14) |
|---|---|
| Gameplay action ack (WS receive → state event emit) p95 | ≤ 250 ms |
| REST p95 (non-money reads) | ≤ 400 ms |
| Availability (API + WS, monthly) | 99.9% class |
| WS connect success | ≥ 99.5% |
| Settlement applied p95 after terminal state | ≤ 2 s |

Error budgets drive the page-vs-ticket burn alerts (§5); budget exhaustion pauses feature deploys per P14 policy.

## 7. Sentry (OQ-10)

Backend + Flutter SDKs; every event tagged `environment` (dev/staging/prod) + `release` (version/build — set by CI so regressions map to releases). **PII scrubbing:** server-side scrubbing ON, denylist mirrors §1, no request bodies, breadcrumbs filtered, user context = opaque userId only. Flutter: obfuscation symbol upload (`--split-debug-info` maps) restricted to CI. Self-host fallback (GlitchTip class) if OQ-01 residency demands — decision at P15.

## 8. Log retention & access control

Logs can reveal security-sensitive patterns (attack traces, risk heuristics, admin activity) even with PII scrubbed. Retention: hot 14d, warm 90d, security-relevant slices (auth, admin, money events) 1y+ per compliance needs (`../06-compliance/kyc-aml.md` §6 for AML-driven minimums — config at P15). Access: read via Grafana/Loki with SSO + role; prod log access restricted to ops/security roles and **itself audited**; no log exports to laptops; Sentry access same tiers. Observability stores are in-scope for the isolation rules (`environments-and-flavors.md` §4).
