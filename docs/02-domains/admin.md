# Domain: Admin (`admin` module + `apps/admin` SPA)

Phase: **P12** (core) · P16 adds KYC review · P17 adds finance/payment ops. Architecture fixed now (per brief) so earlier phases leave the right seams (audited services, queue models, flag framework).

## 1. Purpose & shape

Operate the platform without SQL access (roadmap P12 objective). Two parts:

- **`apps/admin`** — separate React SPA (not Flutter; different audience, desktop-first, independent release cadence).
- **`admin` module** — in the same NestJS API (modular monolith, ADR-003), exposing `/admin/v1/*`, guarded by its own auth stack. It orchestrates *exported services* of other domains (wallet adjustments, risk cases, flags…) — it owns admin identity/RBAC tables only, never other modules' tables (rule 20).

## 2. Admin identity & session policy

- **Separate identity from player accounts** — own `admin_users` table, no shared credentials, no linkage login. A platform operator who also plays uses two unrelated accounts.
- **Mandatory TOTP 2FA** — enrollment forced at first login; no 2FA-less admin session exists. Recovery codes single-use, issuance audited. (Phishing-resistant upgrade path: WebAuthn/passkeys as second factor is the recommended P14-hardening upgrade — TOTP is the P12 floor, see §7.)
- **Optional IP allowlist** per admin user and/or globally (config; recommended ON for finance/superadmin in prod).
- **Stricter session policy than players:** short access TTL (~10 min like players but with **short absolute session lifetime**, e.g. 8–12h re-auth); refresh rotation without the 30-day sliding longevity players get — no long-lived refresh families; idle timeout; re-prompt 2FA for sensitive operations (step-up: four-eyes approvals, key material views).
- Admin sessions/devices recorded like player sessions (PG truth) and revocable individually/globally.

## 3. RBAC roles & capability matrix

Roles are additive-capability sets; one admin may hold several. Every `/admin/v1` endpoint declares required capability; matrix tests at P12 (every endpoint × role) are acceptance criteria.

| Capability | support | risk | finance | ops | superadmin |
|---|---|---|---|---|---|
| User search / view (PII reads audited) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Account actions (suspend, force-logout, notes) | ✔ | ✔ | — | — | ✔ |
| Wallet views | ✔ | ✔ | ✔ | — | ✔ |
| Wallet adjustments (reversal-based) | — | — | ✔ (four-eyes > threshold) | — | ✔ |
| Risk queues / cases / actions (flag→freeze lift) | view | ✔ | view | — | ✔ |
| Risk rule & weight editing | — | ✔ | — | — | ✔ |
| RG state view / mandated exclusions | view | view | — | ✔ | ✔ |
| Game ops: live tables, void oversight | view | view | — | ✔ | ✔ |
| Kill-switches (game/feature/maintenance) | — | — | — | ✔ | ✔ |
| `compliance.real_money_enabled` | — | — | — | four-eyes | four-eyes |
| Feature flags (non-compliance) | — | — | — | ✔ | ✔ |
| Audit-log browser | own scope | domain scope | domain scope | domain scope | ✔ |
| Reconciliation dashboard | — | — | ✔ | ✔ | ✔ |
| KYC review (P16) | — | ✔ | — | — | ✔ |
| Payment ops (P17: withdrawal review, PSP recon) | — | review-input | ✔ | — | ✔ |
| Admin user management, role grants, allowlists | — | — | — | — | ✔ (four-eyes on superadmin grant) |

Least privilege is the default posture: new capabilities start unassigned; superadmin count kept minimal; role grants audited and four-eyed for superadmin.

## 4. Four-eyes operations

Mandatory second-approver flow (initiator ≠ approver, both 2FA-verified, both recorded in audit):

- `compliance.real_money_enabled` flag change (rule 11 — any direction).
- Ledger adjustments/reversals **above threshold** (config, per currency; below threshold single finance admin, still audited).
- Superadmin role grants; admin-user unlock after security lockout.
- (P18) geo-fencing policy changes; large payout release.

Implementation: proposal row (`admin_approvals`: op payload hash, initiator, expiry) → second admin approves → execution runs against the *hashed payload* (approver approves exactly what executes). Pending proposals expire; expiry audited.

## 5. Audit trail (incl. read-access audits)

Everything in §3/§4 writes to the append-only audit log (`docs/02-domains/audit-logging.md`), sync in-transaction: **an unaudited admin mutation cannot commit**. Additionally, **PII views are read-audited**: opening a user's profile, KYC case (P16), or payment instrument details (P17) writes a read-audit event (actor, object, timestamp, reason field where flow requires one). Read-audits deter and evidence insider misuse — the admin panel is where PII is *visible*, so it is where reads are logged. The audit browser audits its own PII-scoped queries.

## 6. API conventions & network posture

- Same error model/envelope and conventions as the public API (`docs/03-api/api-conventions.md`), under **`/admin/v1`** prefix; idempotency keys on mutations; cursor pagination.
- **Not reachable from the public edge where possible:** recommended deployment is a **separate hostname** (e.g. `admin.<domain>`) with its own WAF rules, allowlist/Zero-Trust access layer in front, and the public WAF configured to drop `/admin/*` at the edge on the player hostname. Same API process (monolith), different ingress path — extraction-ready if admin ever becomes its own deployable.
- Admin SPA served from the admin hostname only; strict CSP; no admin JS on the player surface.
- Rate limiting: strict per-admin + per-IP classes on auth endpoints; alerting on failed-login and 2FA-failure bursts.

## 7. Threat notes

**Admin is the highest-value target in the system** — one compromised superadmin outranks any client exploit (server-authoritative cuts both ways).

- **Phishing:** TOTP is phishable; the P12 floor accepts this with allowlist + short sessions as compensating controls. **WebAuthn/passkey second factor is the planned hardening step** (P14 review item) — phishing-resistant, cheap in a React SPA.
- **Least privilege + separation:** no daily-driver superadmins; finance and ops separated so no single role moves money *and* flips gates; four-eyes on the operations that would let one insider do maximal damage.
- **No direct SQL in runbooks:** every operational task exists as an audited admin capability or an audited CLI (P4-era CLI retires as P12 covers it); runbooks (`docs/07-operations/runbooks.md`) must never instruct raw SQL against prod — if a task needs SQL, that's a missing admin feature (file it).
- **Session theft:** short TTLs, step-up 2FA on sensitive ops, IP-bind option per session, revoke-all on anomaly (risk signals apply to admin sessions too).
- **Supply chain / SPA integrity:** admin SPA build pinned + CI-built only; dependency scanning shared with P0 baseline.
- Admin actions are inputs to the risk engine's audit-anomaly review at P14+ (e.g. off-hours mass PII reads alert).

## 8. Feature surface by phase

| Phase | Surface |
|---|---|
| **P12 (core)** | admin auth (TOTP, RBAC, allowlist); user search + account actions; wallet views + reversal-based adjustments (four-eyes > threshold); game ops (live tables, per-game kill-switches, void oversight); risk review queues + case notes + rule editing; feature-flag/kill-switch UI (four-eyes on real-money gate); audit-log browser + export; reconciliation dashboard |
| P16 | KYC review queue, verdict overrides, document re-check triggers (PII reads audited, provider-side doc storage preferred per `docs/02-domains/kyc-verification.md`) |
| P17 | finance ops: withdrawal manual-review queue, PSP reconciliation views, payout release (four-eyes above threshold), chargeback states |
| P18 | geo-fencing policy UI, AML report review/export, launch runbook controls |

Until P12, operations run on audited CLIs (P4 wallet adjustments) and migration-managed flags (P1) — the admin panel replaces, and then forbids, those paths.
