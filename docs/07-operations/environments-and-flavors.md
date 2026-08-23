# Environments & Flavors

Canonical config matrix for **dev / staging / prod** backend environments ↔ Flutter flavors (ADR-012). Rule: three fully isolated stacks; staging mirrors prod topology (incl. WAF + own cert pins) so security machinery is exercised before prod. Cloud/hosting specifics pending OQ-06 (ADR-011 PROPOSED) — everything below is provider-agnostic.

## 1. The matrix

| Dimension | dev | staging | prod |
|---|---|---|---|
| Backend env | `dev` (shared dev stack; local docker-compose for inner loop) | `staging` | `prod` |
| Flutter flavor | `dev` | `staging` | `prod` |
| applicationId | `<base>.dev` | `<base>.stg` | `<base>` |
| App name / icon badge | "App DEV" / DEV badge | "App STG" / STG badge | final name, no badge |
| API base URL | `https://api.dev.<domain>/api/v1` | `https://api.stg.<domain>/api/v1` | `https://api.<domain>/api/v1` |
| WS URL | `wss://ws.dev.<domain>` (`/lobby`,`/game`) | `wss://ws.stg.<domain>` | `wss://ws.<domain>` |
| WAF posture | Optional/log-only; origin may be reachable for debugging | **Full prod posture** (WAF, origin allowlist/tunnel, rate rules) | Full posture; origin never directly reachable |
| Cert pins (SPKI) | Pinning code ON, dev pin set (relaxed rotation) | **Own staging pins**, prod-identical mechanism + backup pin | Prod pins + backup pin; rotation per runbook c |
| APK signing key | debug/dev key (CI-held, low value) | staging key (CI secret store, rotatable) | **prod key — offline/HSM custody, never in CI** (runbook d) |
| Firebase-or-similar project (if used, OQ-09) | separate dev project | separate staging project | separate prod project |
| Secret source | dev secret manager scope (or local `.env` for docker-compose only) | secret manager, staging scope | secret manager, prod scope, tightest access |
| Data policy | **synthetic only** | **synthetic only** (incl. load-test fixtures) | real data; never copied downward |
| Faucet (`TST` credits) | enabled, generous limits | enabled, RG-limited (exercises limit machinery) | **disabled** (exists only behind flag; real money via P17 when licensed) |
| Real-money flag `compliance.real_money_enabled` | **hard OFF** | **hard OFF** | OFF by default; ON only post-P18 with license, four-eyes (rule 11) |
| Feature-flag defaults | new flags ON for dev | prod-like defaults; flags under test explicitly ON | conservative; new features OFF until enabled |
| Log verbosity | `debug` | `info` | `info` (`warn` for noisy modules); no payload bodies anywhere |
| Sentry env tag (OQ-10) | `dev` (sampled low or off) | `staging` | `prod` |
| Observability stack | shared dev Grafana/Prom/Loki | own stack, prod-like dashboards/alerts (alerts → ticket not page) | full stack, paging enabled |

## 2. Client config flow (Flutter)

Per rule 14: client build config **only** from `--dart-define-from-file` per-flavor files, gitignored; `.example` templates committed. Nothing in these files is secret — anything shipped in the APK is public; these are *endpoints and toggles*, never keys.

Files: `apps/mobile/env/{dev,staging,prod}.env.json` (+ committed `*.env.json.example`).

| Client config key | Example (dev) | Notes |
|---|---|---|
| `API_BASE_URL` | `https://api.dev.<domain>/api/v1` | |
| `WS_BASE_URL` | `wss://ws.dev.<domain>` | |
| `FLAVOR` | `dev` | drives badges, Sentry env tag |
| `SPKI_PINS` | `pin1,pin2` | current + backup pin (public values) |
| `UPDATE_MANIFEST_URL` | `https://get.dev.<domain>/latest.json` | updater check (P13) |
| `MANIFEST_PUBKEY` | base64 SPKI | pinned manifest-verify key (public) |
| `SENTRY_DSN` | dev DSN | DSN is not a secret but is per-project |
| `LOG_LEVEL` | `debug` | client-side log gate |

Adding a key = update all three `.example` files + this table in the same PR (rule 29).

## 3. Backend config flow

Env vars injected at deploy from the secret manager (OQ-06); never baked into images; validated at boot by the config module's schema (P1) — missing/invalid config fails startup, fail-closed.

| Key | Secret? | Lives in |
|---|---|---|
| `DATABASE_URL` | **secret** | secret manager |
| `REDIS_URL` | **secret** | secret manager |
| `JWT_SIGNING_KEY` (ES256, kid-rotated) | **secret** | secret manager |
| `WS_TICKET_SECRET` | **secret** | secret manager |
| `PSP_*` / `KYC_*` credentials (P16/P17) | **secret** | secret manager |
| `WEBHOOK_SIGNING_SECRETS` | **secret** | secret manager |
| `PII_ENCRYPTION_KEY` refs | **secret** | secret manager (KMS-backed) |
| `SENTRY_DSN` | non-secret | env config |
| `OTEL_EXPORTER_*` | non-secret | env config |
| `APP_ENV` (`dev`/`staging`/`prod`) | non-secret | env config |
| `LOG_LEVEL` | non-secret | env config |
| `CORS_ORIGINS`, `PUBLIC_BASE_URL` | non-secret | env config |
| Feature-flag/kill-switch state | n/a | **DB-backed** (P1), Redis-cached — not env vars |
| Jurisdiction config (P15+) | n/a | DB-backed per `../06-compliance/jurisdiction-matrix.md` §3 |

CI secrets (deploy credentials, staging signing key) live **only** in the CI secret store; cloud auth via OIDC, no long-lived keys (`ci-cd.md` §4).

## 4. Isolation rules (normative)

1. No shared infra between environments: separate PG, Redis, secret-manager scopes, WAF configs, DNS names, observability projects.
2. No shared secrets — a leaked staging credential must be worthless in prod.
3. **Prod data never leaves prod.** No prod dumps to staging/dev, ever — debugging uses synthetic reproductions; staging load tests use generated fixtures. (Removes the entire class of "PII in dev" incidents; PII minimization per `../06-compliance/kyc-aml.md` §7.)
4. Cross-environment network paths blocked (staging cannot reach prod PG even with credentials).
5. Flavors install side-by-side on one device (distinct applicationIds) — a P2 acceptance criterion.

## 5. Promotion path

`dev → staging → prod`, same artifact promoted (container image by digest; APK per-flavor is a *rebuild* with the flavor's config + signing key, same commit).

| Step | Gate |
|---|---|
| merge to `main` | full CI green (`ci-cd.md` §2) |
| auto-deploy `staging` | migrations first, then rollout; smoke + update-path e2e |
| soak on staging | staging alert quiet-period; release checks |
| deploy `prod` | manual approval (GitHub environment protection), tagged release, four-eyes for risky changes |
| post-deploy | health/SLO watch, staged APK rollout % (`distribution-and-updates.md` §5) |

Rollback: `ci-cd.md` §7 (images roll back; APKs only roll **forward**).
