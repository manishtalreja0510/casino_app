# CI/CD — GitHub Actions

Repo is on GitHub; CI/CD is GitHub Actions (`/.github/workflows`). Skeleton lands **P0**, grows per phase; release lanes complete at **P13**. Cloud deploy targets pending **OQ-06** — deploy jobs are written provider-agnostic (container registry + deploy step behind a composite action).

## 1. Principles

- Path-filtered per workspace (pnpm/Turborepo + melos) — a Flutter-only PR doesn't run backend integration lanes.
- Every merge to `main` is deployable to staging; prod is a promotion, not a rebuild (image by digest).
- No long-lived cloud keys in CI — **OIDC** federation only (§4).
- Prod APK signing key is **never** a CI secret (§5).
- Failing checks block merge — no override culture (rule 18).

## 2. Pipeline stages (PR + main)

| Stage | Contents | Scope |
|---|---|---|
| Lint/format/typecheck | ESLint + Prettier + `tsc` per TS workspace; `dart analyze` + format; custom no-hardcoded-style lint (rule 25) | path-filtered |
| Unit tests | Jest (api, packages); `flutter_test` incl. ui_kit goldens | path-filtered |
| **Contract codegen drift** | regenerate Dart `api_client` + TS types from `packages/contracts`; fail on diff — hand-edited or stale generated code cannot merge | contracts or clients touched |
| Security scans | gitleaks (full history on schedule, diff on PR); dependency audit (pnpm audit + osv-scanner class; Dart `pub` audit); APK string-dump spot check for secrets (P2 acceptance) | all |
| Build | api image build; contracts build; Flutter debug build compile check | path-filtered |
| Integration lane | **Testcontainers** (PG 16 + Redis 7) + supertest API tests; ledger constraint tests (no UPDATE/DELETE, zero-sum); Socket.IO harness smoke | api touched |
| Flutter per-flavor build | assemble `dev`/`staging` (+ `prod` unsigned compile check) with `--dart-define-from-file` from CI-provided non-secret env files; `--obfuscate --split-debug-info` on release builds | mobile touched |
| Migration check | `drizzle-kit` generated SQL reviewed-in-PR rule: migration lint (append-only ledger guard untouched, no destructive DDL without marker), apply-from-scratch + apply-on-top against Testcontainers PG | migrations touched |

Scheduled (nightly): full-history gitleaks, dependency audit, k6 smoke vs staging, backup-verification hooks (`backup-disaster-recovery.md` §9).

## 3. Environments & protection rules

GitHub *Environments*: `staging`, `production`.

| Environment | Trigger | Protection |
|---|---|---|
| staging | auto on merge to `main` | none beyond green CI; deploys migrations → app → smoke suite (incl. update-path e2e, rule 17) |
| production | manual, from a **tag** (`vX.Y.Z`) | required reviewers (manual approval), `main`-only, secrets scoped to environment; four-eyes convention for risky deploys |

Branch protection on `main`: PR required, required checks = all §2 stages, linear history, no force-push, signed commits recommended, CODEOWNERS for `packages/contracts`, `docs/`, migrations, and workflow files.

## 4. Cloud auth — OIDC (pending OQ-06)

CI authenticates to the cloud/registry via **GitHub OIDC → short-lived federated role**, scoped per environment (staging role cannot touch prod). No stored cloud access keys. Concrete provider wiring (AWS role-assume per ADR-011 recommendation, or equivalent) lands when OQ-06 is confirmed; workflows reference a composite `cloud-login` action so the swap is one file.

## 5. APK release pipeline (P13; channel detail in `distribution-and-updates.md`)

| Lane | Trigger | Signing | Output |
|---|---|---|---|
| dev build | PR/merge | debug/dev key (CI) | artifact for internal install |
| **staging release** | merge to `main` | staging key from CI secret store | signed staging APK → staging distribution host; staging manifest updated |
| **prod release** | tag `vX.Y.Z` + prod-environment approval | **NOT plain CI secrets.** Options (decide in P13 plan): (a) **offline signing step** — CI produces unsigned artifact + checksums; release engineer signs on the custody machine per runbook d and uploads; CI verifies signature matches pinned cert before publish; (b) **HSM/KMS-backed signing** — CI calls a signing service with OIDC-scoped, audited, approval-gated access; key never exportable | signed prod APK |
| publish | after signing | — | SHA-256 checksums; **signed release manifest** (latest.json class: version, minSupported, url, sha256, releaseNotes, rollout %) signed with the offline manifest key (runbook d); upload APK + manifest to distribution host; staged rollout % set low |

Every release lane ends with the **update-path e2e**: previous release build must detect, download, verify, and prompt-install the new build (rule 17 — the forced-update channel may never break).

## 6. Migration deploy strategy

1. Migrations run **before** app rollout, as their own gated step, in a transaction where DDL allows.
2. **Backward-compatible rule:** every migration must be safe under the *previous* app version still running (expand → migrate → contract across releases; no drop/rename in the same release that stops using the column). Verified in staging by running old-image smoke against migrated schema.
3. Ledger/audit tables: append-only guards are themselves migration-protected; any migration touching them requires explicit marker + review (CODEOWNERS).
4. Failed migration = deploy aborts, app untouched; contract step reverts only via a new forward migration (no down-migrations in prod).

## 7. Rollback procedures

| Layer | Procedure |
|---|---|
| API/app image | redeploy previous image digest (kept ≥ N releases); safe because migrations are backward-compatible (§6); verify health + reconciliation clean after |
| Migration gone wrong | forward-fix migration; if data-corrupting → incident runbook g/h (freeze scope first) |
| **APK** | **never downgrade** — Android blocks versionCode downgrades and old clients may be the vulnerability. Rollback = ship fixed vN+1 and, if the bad version is dangerous, raise `minSupported` to force it out (`distribution-and-updates.md` §4, runbook f). Halt staged rollout immediately (manifest rollout % → 0) |
| Feature | kill-switch/flag off first — prefer flag-off over redeploy for behavior rollback |

## 8. Versioning & changelog

- SemVer tags `vX.Y.Z` per release; Android `versionCode` monotonic (CI-derived); `versionName = X.Y.Z`.
- Conventional Commits → generated changelog per release; releaseNotes field in the signed manifest derives from it (player-safe subset).
- `packages/contracts` carries its own version; breaking API change ⇒ new API version + forced-update plan (rule 23).
- Release = tag + GitHub Release + manifest entry + `docs/progress.md` note.
