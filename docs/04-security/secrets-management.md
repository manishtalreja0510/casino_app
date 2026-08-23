# Secrets Management

Rule 14 (⛔) is the law of this doc: **no secrets in code, repo, git history, or binary — ever.** Anything shipped in the APK is public. Backend secrets come only from the secret manager at deploy; CI secrets only from the CI secret store; suspected leak → rotation runbook immediately (`../07-operations/runbooks.md`). Decision record: ADR-011 (PROPOSED, OQ-06).

## 1. Rules (normative)

1. No secret value in source, config committed to git, docs, tickets, chat logs, or build artifacts. `.example` templates with placeholder values are the only committed shape of env files.
2. Secrets are injected **at deploy time as environment variables** from the secret manager; never baked into container images; never in image layers or `docker history`.
3. Every secret has an **owner, rotation cadence, and known blast radius** (inventory, §2). Unrotatable secrets are design bugs.
4. Client-side "config" is public by definition (§4). If it must be secret, it cannot live in the app.
5. Logs never contain secrets (rule 15); serializers deny-list token/secret-shaped fields, tested in P1.
6. Humans see prod secrets only through the secret manager's audited access path, never via shared vaults/spreadsheets/DMs.

## 2. Secret inventory

| Secret class | Stored in | Accessed by | Rotation cadence | Leak blast radius |
|---|---|---|---|---|
| PG credentials (per env) | Secret manager | API deploy role; migrations job | 90 d + on incident | Full data-tier compromise of that env (ledger is append-only + audited, but reads = PII/game data) |
| Redis credentials (per env) | Secret manager | API deploy role | 90 d + on incident | Session cache, queues, hot game state; no financial truth (rule 7) |
| JWT ES256 signing keys (`kid`-versioned) | Secret manager (private keys) | auth module at runtime | ~90 d via `kid` rotation with overlap; immediate on suspicion | Forge access tokens for TTL window until rotated (`./authentication-security.md §2`) |
| Webhook verification secrets (PSP/KYC, P16/17) | Secret manager | payments/kyc adapters | Per provider capability; on incident | Forged deposits/KYC verdicts until rotated — reconciliation is the backstop (`./financial-security.md §5`) |
| PSP / KYC API keys (P16/17) | Secret manager | payments/kyc adapters | Provider cadence; on incident | Payout initiation attempts, PII exposure at provider; provider-side limits + review thresholds bound it |
| APK signing key — **prod** | **Offline / HSM; never in cloud secret manager** | Release ceremony only (§7) | Effectively never (Android identity); compromise = incident, not rotation | Attacker signs "genuine" updates — worst channel event (`./threat-model.md` TB4) |
| APK signing key — staging | CI-accessible store, separate from prod | CI release pipeline | Yearly / on incident | Staging-flavor impersonation only (separate applicationId) |
| Pinning-update key (signs remote pin manifests) | **Offline**, same custody class as prod APK key | Pin-rotation ceremony only | On compromise only | Attacker can steer app pin-sets → MITM path (`./network-security.md §3`) |
| Update-manifest signing key (P13 releases) | Offline or HSM-backed CI signing with approval gate | Release pipeline | Yearly / on incident | Malicious update prompts (still limited by APK signature continuity) |
| Admin bootstrap credential (first superadmin) | Secret manager, single-use | P12 provisioning | Destroyed after enrollment | Admin-plane takeover if left alive — checklist forces destruction |
| CI deploy credentials | GitHub Actions **environment-scoped** secrets; **OIDC federation to cloud preferred over long-lived keys** | CI workflows per environment | OIDC: none to rotate; static fallback 90 d | Deploy/infra mutation in that env |
| Grafana/Sentry/observability tokens (OQ-10) | Secret manager | API + CI | 180 d | Telemetry access; no player-data write path |
| *Sensitive artifact (not a secret): obfuscation mapping files* | CI artifact store / symbol server, restricted | Crash triage | retained per supported-version window | Deobfuscates released binaries (`./mobile-app-hardening.md §1`) |

## 3. Secret manager (OQ-06 / ADR-011)

**Recommendation: AWS Secrets Manager** (with the recommended AWS stack), pending owner confirmation.

| | AWS Secrets Manager | HashiCorp Vault |
|---|---|---|
| Ops burden | Managed, ~zero | Self-run cluster: unsealing, storage, upgrades, HA |
| Rotation | Built-in for RDS etc.; Lambda hooks | Superior: **dynamic short-lived DB creds**, transit encryption |
| Access control | IAM (already the deploy plane) | Own policy system (powerful, one more system) |
| Audit | CloudTrail | Own audit device |
| Verdict | **Right size for a small team now** | Revisit when team/ops maturity grows or multi-cloud forces it |

Injection: task/deploy role reads secrets at deploy → env vars in the runtime environment. Config module (P1) schema-validates presence at boot and **fails closed**. No secrets in images, task definitions committed to git, or CI logs (masked + never echoed). Per-env isolation: dev/staging/prod secrets are disjoint stores/paths with disjoint IAM roles — staging credentials open nothing in prod.

## 4. Client-side configuration (public by definition)

- Per-flavor config via `--dart-define-from-file` with **gitignored** env files; committed `.example` templates document every key (P0/P2).
- **Dart-defines are NOT secret storage.** Everything in the APK — dart-defines, assets, strings — is recoverable by anyone with the file. Permitted content: **endpoints, flavor names, feature flags, public keys (pins, manifest-verify key), Sentry DSN-class identifiers.** Forbidden: API secrets, signing secrets, anything whose exposure harms anyone but its holder.
- CI enforces the posture with a **string-dump check** on release binaries against known secret patterns (`./security-checklist.md` D-gates).

## 5. CI secrets (GitHub Actions)

- GitHub Actions secret store, **environment-scoped** (`dev`/`staging`/`prod` environments with protection rules: reviewers required for prod, branch restrictions).
- **OIDC federation to the cloud provider preferred over long-lived cloud keys** — short-lived tokens per run, per-repo/branch trust conditions, nothing static to leak or rotate.
- Fork PRs get no secrets (default GitHub behavior kept); `pull_request_target` usage forbidden without security review.
- Third-party actions pinned by commit SHA; workflow changes touching secrets require review (CODEOWNERS on `.github/workflows`).

## 6. Detection

- **gitleaks in CI** on every PR (blocking) — P0 deliverable.
- **Periodic full-history scans** (scheduled workflow) — catches patterns added to rulesets after the fact; history is forever, scanning must be too.
- Secret-shaped strings in logs: scrubber tests in P1; spot audits in P14.
- GitHub secret-scanning + push protection enabled on the repo (`mcp` native GitHub features).
- A *detected historical* secret is treated as **leaked** regardless of whether the file was later deleted — history rewrite does not un-leak; rotation does (runbook).

## 7. APK signing & offline key custody

- **Prod APK signing key: critical infrastructure** (brief, canonical). Generated and held **offline (or HSM)**; never on developer machines, never in CI. Release signing is a **documented ceremony**: two-person integrity, checklist, audit entry per release; procedure and storage detail live in `../07-operations/runbooks.md` (key-custody runbook).
- Loss = users must reinstall (identity break); theft = attacker can sign "genuine" updates. Both are top-tier incidents (`./threat-model.md` §4 rank 8, TB4).
- **Staging key is separate** and CI-usable — staging flavor (`.stg` applicationId) never shares prod identity, so staging automation can't endanger the prod channel.
- **Pinning-update key** shares the offline custody class (its compromise steers the fleet's pins, `./network-security.md §3`).

## 8. Leak response (summary — full procedure in `../07-operations/runbooks.md`)

On suspected leak, in order, without waiting for certainty:
1. **Rotate** the secret (issue new, deploy, invalidate old).
2. **Revoke** derived material (sessions, tokens, deploy creds minted from it).
3. **Assess** blast radius from the inventory row (§2) — what could the holder have done, over what window; check for actual abuse (audit log, reconciliation, provider dashboards).
4. **Audit**: incident entry, timeline, root cause, and a rule/scan improvement so the same leak class is caught earlier next time.
Financial-secret leaks additionally trigger reconciliation runs and, where warranted, scope freezes (`./financial-security.md §10`).

## 9. Developer workflow

- Local dev uses **gitignored `.env` files** seeded from committed `.example` templates; direnv-style auto-loading acceptable; files live outside any path that gets bundled.
- **Never real prod values locally.** Local/dev secrets are dev-env-only; prod values exist solely in the prod secret store and the offline custody locations.
- No secrets in shell history-prone one-liners for prod operations — use the secret manager's exec/injection tooling.
- Onboarding/offboarding checklists include secret-access grants/revocation (IAM groups, GitHub teams) — access is role-based, never personal long-lived keys.
