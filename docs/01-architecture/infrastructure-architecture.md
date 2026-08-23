# Infrastructure Architecture

**Provider-agnostic until OQ-06 is confirmed.** ADR-011 (PROPOSED) recommends **AWS (ECS Fargate → EKS later, RDS Postgres, ElastiCache Redis) + AWS Secrets Manager + Cloudflare** in front; every provider-specific statement below is marked **PROPOSED** and must not drive spend before the owner confirms OQ-06. Everything else here holds for any provider that offers managed Postgres, managed Redis, and a container runtime.

## 1. Environments

Three fully isolated environments — **dev / staging / prod** — matching the Flutter flavors (ADR-012, `docs/07-operations/environments-and-flavors.md`). Isolation means: separate data stores, separate secrets (own secret-manager scope), separate networks/accounts (PROPOSED: separate AWS accounts per env), separate WAF zones, separate domains, separate signing/pin material. No shared anything; a staging credential must be worthless in prod.

**Staging mirrors prod topology** — including the WAF layer and certificate pinning with its **own pins** — so pin rotation, forced update, kill-switches, and WAF rules are rehearsed before they can hurt prod. Dev may collapse to a cheaper single-node footprint but keeps the same shape (edge in front, secrets injected, no direct origin).

## 2. Topology per environment

```
                    WAF / CDN / DDoS  (edge — §5)
                          │  (origin allowlist or tunnel; no direct origin access)
                    Load balancer (TLS termination or passthrough per ADR-013)
                          │            sticky sessions only for Socket.IO polling
              ┌───────────┼───────────┐          fallback (WS-only preferred)
        api container … api container … (N, stateless, ROLE=api)
        worker container … (M, ROLE=worker: BullMQ, reconciliation, schedulers)
                          │ private network
     ┌────────────────────┼────────────────────┐
 PostgreSQL primary   PostgreSQL replica    Redis 7+
 (truth — ADR-004)    (read/DR — §7)        (cache/queues/adapter — disposable)
                          │
                  Secret manager (OQ-06) — deploy-time injection only
```

All containers run the **same image**; `ROLE` (api / worker / all-in-one) selects the profile (`backend-architecture.md §14`). API/WS containers are stateless — any instance can serve any user; live WS fan-out coordinates through the Socket.IO Redis adapter.

## 3. Container & deploy model

- **Single immutable image per release** (one build, promoted dev → staging → prod; never rebuilt per env — env differences are config/secrets only).
- **Health-gated rollouts:** readiness endpoint (checks PG, Redis, migrations applied, config valid — fail-fast per `backend-architecture.md §6`) gates traffic; rolling deploy replaces instances only while health stays green.
- **Rollback = redeploy previous image tag.** DB migrations follow the zero-downtime rules (`database-architecture.md §8`) so image rollback never requires a schema rollback.
- Migrations run as a locked pre-deploy step. WS deploys drain: instance stops accepting connections, existing sockets get a reconnect hint, resume protocol (P5) carries players across (tested in P5 acceptance).

## 4. Scaling model

| Tier | Strategy | Limits / triggers |
|---|---|---|
| api/ws containers | horizontal, stateless; Socket.IO Redis adapter for cross-instance rooms | scale on CPU + socket count; P14 load targets (5k conns / 500 tables baseline) validate headroom |
| workers | horizontal, competing consumers on BullMQ | scale on queue depth/latency |
| PostgreSQL | vertical first; + read replicas for replica-ok reads (`database-architecture.md §9`) | partitioning before sharding; sharding out of scope |
| Redis | single instance + sentinel or managed-failover equivalent (PROPOSED: ElastiCache) | Redis is rebuildable (ADR-005): failover may drop hot state; recovery = PG snapshot+replay |

## 5. Edge layer (WAF/CDN — PROPOSED: Cloudflare)

- **Origin isolation:** origin accepts traffic only from the edge (IP allowlist or tunnel, e.g. `cloudflared` — PROPOSED); direct-to-origin requests are dropped at the network layer.
- DDoS absorption, bot rules, and the **edge rate-limit tier** (volumetric per-IP) in front of the app-level Redis token buckets (`security-architecture.md §5`).
- WebSocket passthrough for Socket.IO; caching only for static assets and the APK download surface (§9) — API responses uncached.
- Staging has its own zone + rules so WAF changes are testable.

## 6. Secrets at deploy

Secrets never bake into images and never enter the repo (rule 14). The deploy pipeline resolves references from the secret manager (OQ-06) and injects env vars at container start (PROPOSED: ECS task-definition secret refs from AWS Secrets Manager). App boots fail-fast on missing/invalid values. Rotation per `docs/07-operations/runbooks.md`; per-env scoping per §1. CI holds only CI-scoped secrets in the GitHub Actions secret store.

## 7. Backup & disaster recovery (summary)

Full doc: `docs/07-operations/backup-disaster-recovery.md` — **RPO/RTO targets are set there**, not here; planning stance:

- **PostgreSQL:** continuous WAL archiving + PITR (managed-provider native — PROPOSED: RDS automated backups + snapshots), plus the streaming replica for fast promotion. Target class: RPO ≈ minutes, RTO ≈ tens of minutes for the launch footprint (to be fixed in the DR doc and drilled in P14 chaos exercises).
- **Redis is rebuildable by design** — no backup requirement. Loss interrupts play, never money (rule 7): queues re-form, hot game state recovers from PG snapshot+replay, sessions re-cache from PG.
- Audit-log head hash exported to write-once external storage (`database-architecture.md §6`) — survives even DB-level compromise.
- Restore drills (including PG failover mid-play) are P14 scope; a backup that hasn't been restored in a drill doesn't count.

## 8. Infrastructure as code

**Terraform recommended** (PROPOSED pending OQ-06): provider-agnostic module structure (`network`, `edge`, `db`, `redis`, `app`, `secrets`, `observability`) with thin provider bindings, one root per environment, remote state with locking, plan-reviewed in PR like any code. No console-clicked resources in staging/prod. Until OQ-06 is confirmed, no cloud resources are provisioned at all (P0 explicitly excludes infra spend); the IaC skeleton can still be written against the module interfaces.

## 9. APK hosting (off-store distribution — ADR-017, P13)

Static hosting on our own domain behind the **same WAF/CDN**: versioned APKs, SHA-256 checksums, and the **signed release manifest** (verified by the app against a pinned public key before any install prompt). HTTPS only; CDN-cached (immutable, versioned paths); upload only via the CI release pipeline (no manual uploads); prod signing key custody is offline/HSM per `docs/07-operations/runbooks.md`. The version-check endpoint (forced update, rule 17) lives in the API, not the static host — it must share the API's availability guarantees.

## 10. Observability stack placement (OQ-10)

- **Prometheus + Grafana + Loki** self-hosted per environment (small single-node stack at start; PROPOSED: on the same container platform), scraping API/worker metrics and ingesting pino JSON logs. Prod alerting → paging channel (reconciliation drift, kill-switch activation, health failures, queue backlog, replica lag).
- **Sentry SaaS** for backend + Flutter error tracking (OQ-10 recommendation; data-residency review at P15 may force self-hosted GlitchTip).
- OTel collector runs beside the app tier, fanning traces/metrics to the stack. Observability infra is env-isolated like everything else; no prod telemetry flows to shared/dev tooling.

## 11. Cost consciousness & non-goals

Start on the **smallest managed footprint** that preserves the topology: 2× api, 1× worker, 1× managed PG (primary + 1 replica), 1× managed Redis, edge free/low tier, single-node observability. **No Kubernetes until needed** — triggers that revisit (ADR-011/ADR-003 territory): >~10 services or extracted modules needing independent orchestration; autoscaling patterns Fargate-class runtimes can't express; multi-region; ops team capacity to own k8s. Likewise deliberately absent for now: multi-region/geo-replication, service mesh, dedicated message bus, CDN-level A/B — each has a recorded trigger in `system-architecture.md §9`.

## 12. OQ-06 decision checklist (what confirmation unlocks)

Confirming OQ-06 (owner + ADR-011 → ACCEPTED) unlocks: account/org structure creation, Terraform provider bindings, secret-manager wiring, edge zone setup, and the P1 deploy target. Until then everything runs locally/CI-only (Testcontainers), and this doc's PROPOSED markers stand.
