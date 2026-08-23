# Domain: Audit Logging (`audit`)

Phase: **P1** (foundation — exists before the first domain, per roadmap P1 scope) · Rule 15 (⛔): every sensitive action audit-logged, append-only, hash-chained, no PII/secrets.

## 1. Purpose — and what this is NOT

The audit log is **security and compliance evidence**: an immutable, tamper-evident record of who did what to what, sufficient to reconstruct sensitive activity for incident response, disputes, and regulators (OQ-01 regimes will demand it).

It is deliberately **not**:
- **Not the user-facing transaction history** — that's the ledger (`docs/02-domains/wallet.md`) rendered by wallet APIs.
- **Not application logging** — pino/Loki logs are operational, sampled, short-retention; the audit log is complete for its catalog and long-retention.
- **Not an event bus** — no domain consumes audit rows to drive behavior; in-process domain events do that. Reading audit to trigger logic is a boundary violation.
- **Not analytics** — no product metrics queries against it; export to an analytics store if ever needed.

## 2. Event model

`audit_log` row:

| Field | Notes |
|---|---|
| `id` | UUIDv7 (time-ordered) |
| `seq` | monotone BIGINT (chain order; PG sequence) |
| `actor_type` / `actor_id` | `user` / `admin` / `system` (job or subsystem name for system) |
| `action` | catalog key, e.g. `wallet.adjustment.reversal`, `auth.login.success`, `game.match.voided` |
| `object_type` / `object_id` | what was acted on (user, account, match, flag, case…) — opaque ids only |
| `context` | jsonb: ip, device_id, session_id, request_id/trace_id, admin 2FA-verified flag |
| `before_ref` / `after_ref` | where applicable: refs to versioned state (e.g. flag value ids, ledger tx ids) — refs, not embedded blobs, where the referenced store is itself immutable; small before/after value pairs inline for config-style changes |
| `created_at` | timestamptz UTC |
| `prev_hash` / `row_hash` | chain fields (§3) |

**No PII beyond opaque ids, no secrets, ever** — same discipline as all logs (rule 15). KYC documents, emails, names never appear; the audit row points at the KYC case id, not its contents. Enforced by writer-service typing (no free-form string fields except catalog-validated `action`) + serializer scrub tests (P1 security scope).

## 3. Append-only, hash-chained table

- **Append-only enforced in PG:** `UPDATE`/`DELETE`/`TRUNCATE` privileges revoked from the app role + trigger guard raising on any attempt (same mechanism as ledger tables, rule 5). Corrections don't exist; a wrong audit row is answered by a subsequent row.
- **Hash chain:** `row_hash = SHA-256(seq ‖ prev_hash ‖ canonical-serialization(row fields))`; `prev_hash` = previous row's `row_hash`. Genesis row fixed. Canonical serialization documented in the schema migration (field order + encoding pinned — a serialization change is a chain epoch, recorded).
- **Off-system anchoring:** periodic job (e.g. hourly + on demand) exports `{last_seq, last_row_hash, timestamp}` signed, to a store outside the primary blast radius (object storage with object lock / WORM; exact target per OQ-06 infra choice). Tamper evidence: an attacker with full DB write access can rewrite history only up to the last exported anchor, and any rewrite breaks verification (§7).
- Chain is single-writer-ordered via the `seq` sequence + short serialization on the writer path; audit write throughput is bounded by the catalog (sensitive actions, not request logs), so this is acceptable — measured at P14.

## 4. Write path

- **Synchronous, same DB transaction** for financial and auth-critical actions: the audit insert participates in the transaction that performs the action, so **an unaudited sensitive action cannot commit** — if the audit write fails, the action rolls back. This is the default for the catalog.
- **Async allowed only for low-criticality events**, exhaustively listed (initial list): `auth.login.success` (failures sync), rate-limit trips, reality-check shown/acknowledged, informational notification sends, session heartbeats-derived events. Async path = BullMQ with at-least-once + idempotent insert (event id unique); loss tolerance explicitly accepted for this list only.
- Writer is a P1 service (`AuditWriter`) exported to all modules; direct table access forbidden (rule 20 pattern; `audit` owns the table).

## 5. Catalog of audited actions (by domain; grows additively, catalog keys in `packages/contracts`)

| Domain | Actions (sync unless noted) |
|---|---|
| `auth` | signup, login failure (success async), logout-all, refresh reuse detected + family revocation, device registered/removed, password change, session revoked, account state change |
| `wallet` | every manual adjustment (reversal-based), faucet grant, escrow open/settle/void refs (tx ids), reconciliation drift + freeze |
| `payments` (P17) | deposit/withdrawal state transitions, webhook accepted/rejected, manual review decisions, payout initiated |
| `kyc` (P16) | verification started, verdict applied, level change, manual override, document re-check |
| `game-engine` | match voided + refund, RNG draw log refs, settlement applied, in-flight recovery outcome |
| `risk` | signal-rule changes, score-threshold actions applied/lifted (flag/limit/review/freeze), case opened/resolved |
| `responsible-gaming` | limit set/changed (incl. pending-increase), cool-off/self-exclusion entered, mandated exclusion applied |
| `platform` | every feature-flag / kill-switch change (incl. both approvals of four-eyes on `compliance.real_money_enabled`), min-version policy change |
| `admin` | **everything**: every admin mutation, every PII read (read-access audit, `docs/02-domains/admin.md §5`), login/2FA events, role grants |

## 6. Query & browse

- Admin audit browser at **P12**: filter by actor, action prefix, object, time range; follow object timelines; export (CSV/JSONL) — export itself audited. Read access per RBAC (support: own-scope reads; risk/finance: domain scope; superadmin: all).
- Until P12: read-only SQL via ops runbook role (no direct SQL for mutations exists anyway — privileges revoked).
- Indexes: `(object_type, object_id, created_at)`, `(actor_type, actor_id, created_at)`, `(action, created_at)`; partitioning by month planned when volume warrants (partition boundaries are chain-neutral — chain runs over `seq`, not partitions).

## 7. Verification job

Scheduled (BullMQ) chain-integrity check: re-hash from the last verified checkpoint to head; compare against stored hashes and the latest off-system anchor. **Any break → page a human immediately** (same severity as ledger drift, rule 9) + freeze audit-dependent admin operations until resolved. Verification progress checkpointed so full-history re-verification is on-demand, incremental verification is routine.

## 8. Retention

Long-lived by default (evidence, not telemetry): **default 7 years, jurisdiction-tunable** at P15 via `docs/06-compliance/jurisdiction-matrix.md` (some regimes mandate 5–10 years for gaming/AML records). Deletion only via documented compliance process operating on whole partitions past retention + anchor bookkeeping — never row-level. Because rows carry no PII, data-subject erasure requests (GDPR-style, if applicable per OQ-01) are satisfied by erasing the id-mapping elsewhere, not by touching the chain — this is *why* the no-PII rule is absolute here.

## 9. Phase mapping

| Phase | Scope |
|---|---|
| **P1** | table + chain + writer service + immutability constraint tests (UPDATE/DELETE rejected), catalog seed (auth/platform), verification job v1, anchor export stub (real target after OQ-06 confirmation) |
| P3–P10 | each domain wires its catalog section as it's built (phase acceptance includes audit completeness) |
| P12 | browser UI, export, read-audit of the browser itself |
| P14 | chain-verification + tamper drill (inject a mutation attempt in staging → detected + paged); write-path throughput measured |
| P15/P18 | retention values + regulator export formats per license |
