# ADR-011: Secrets & Configuration Management

**Status:** ACCEPTED (2026-08-23 — AWS + AWS Secrets Manager confirmed by owner via OQ-06; see ADR-021 for the local-first development mandate that applies until cloud provisioning is approved)
**Date:** 2026-08-23

## Context

Rule 14 (⛔): no secrets in code, repo, git history, or binary — ever. We need: a secret store for backend runtime secrets (DB creds, JWT signing keys, PSP/KYC API keys later), a config-injection model for three isolated environments (ADR-012), and a CI credential story. The team is small; ops burden is a real cost. Cloud/hosting provider is itself part of OQ-06.

## Decision

### Secret manager comparison

| | HashiCorp Vault (self-hosted) | AWS Secrets Manager (+KMS) | GCP Secret Manager | Azure Key Vault |
|---|---|---|---|---|
| Ops burden | High: HA cluster, unseal/key-holder process, upgrades, audit devices | None (managed) | None | None |
| Rotation automation | Excellent (dynamic creds, leases) | Good (Lambda rotators; RDS built-in) | Manual/Functions | Good (Key Vault + Functions) |
| IAM integration | Own policy model + cloud auth backends | Native IAM, resource policies | Native IAM | Native AAD |
| Dynamic DB credentials | Yes (first-class) | No (rotation only) | No | No |
| Cost | Infra + engineer time | ~$0.40/secret/mo + calls | ~$0.06/version/mo | Low |
| Lock-in | Low (portable) | AWS | GCP | Azure |

**Recommendation (pending OQ-06 confirmation): AWS hosting + AWS Secrets Manager with KMS.** Vault's headline advantages (dynamic DB creds, transit encryption, detailed audit device) do not outweigh running and securing a Vault cluster with a small team — the secret store becoming the weakest link is a real failure mode. **Revisit Vault if** multi-cloud becomes real or dynamic per-service DB credentials become a compliance/scale need.

### Configuration layering (holds regardless of provider)

- Backend: secrets fetched from the secret manager and **injected as env vars at deploy**; the app never calls the secret store at request time. Config module validates the full env against a schema at boot and **fails fast** on any missing/invalid value (P1).
- Client: per-flavor `--dart-define-from-file` env files, gitignored; only `.example` templates committed. Nothing secret ships in the APK (it is public by definition).
- CI: GitHub Actions authenticates to the cloud via **OIDC federation — no long-lived cloud keys** stored in GitHub. CI-only secrets live in the GitHub encrypted secret store.
- Rotation + leak-response runbooks in `docs/07-operations/runbooks.md`; suspected leak triggers immediate rotation.

## Alternatives considered

- **Self-hosted Vault now** — most capable, but HA complexity, unseal ceremonies, and 24/7 ops ownership are premature; rejected for start, kept as the named revisit path.
- **GCP Secret Manager / Azure Key Vault** — fine products; ruled by the hosting choice, and AWS is the recommended host (RDS/ElastiCache/ECS maturity, gambling-adjacent ecosystem familiarity).
- **SOPS/sealed files in repo** — encrypted secrets in git still concentrate risk in one KMS key and make rotation/audit weak; rejected.
- **Plain CI/host env vars with no manager** — no audit, no rotation story, sprawl; rejected.

## Consequences

- Zero secret-store ops at start; IAM-scoped access per environment; rotation automatable per secret.
- AWS lock-in accepted knowingly; the deploy-time env-var injection seam keeps the app itself provider-agnostic until OQ-06 is confirmed.
- No dynamic DB creds: DB passwords are rotated, not leased — acceptable at this scale.
- Fail-fast env validation means a bad deploy dies at boot, never half-configured at runtime.

## Links

- ../00-project/open-questions.md (OQ-06), ../00-project/system-rules.md (rule 14)
- ../01-architecture/infrastructure-architecture.md, ../07-operations/environments-and-flavors.md
- ADR-012-environment-and-flavor-strategy.md · Phases: P0, P1
