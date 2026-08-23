# apps/admin — Admin panel (React SPA)

**Status: workspace slot only. Built in P12 — Admin panel v1.**

Design: `../../docs/02-domains/admin.md`. The admin API module lives in `apps/api` under `/admin/v1`; this directory holds only the SPA.

Non-negotiables that apply when this is built:

- Admin identity is separate from player accounts — no shared credentials.
- Mandatory TOTP 2FA, RBAC (support / risk / finance / ops / superadmin), optional IP allowlist.
- Its own audit trail, including read-access audits for PII views (rule 15).
- Four-eyes approval for the real-money gate flag, ledger reversals, and large adjustments.
