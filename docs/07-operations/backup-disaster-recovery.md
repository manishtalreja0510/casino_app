# Backup & Disaster Recovery

PG is the sole source of truth (ADR-004) — protecting it *is* protecting the business. Redis is rebuildable by design (ADR-005, rule 7). Concrete infra bindings pending OQ-06; everything below is provider-agnostic and mandatory regardless of provider. Drill procedures: `runbooks.md` h/i.

## 1. Targets

| Target | Value | Notes |
|---|---|---|
| **RPO** | ≤ 5 min | continuous WAL archiving |
| **RTO** | 1–4 h class | set finally in the P14 plan after timed drills |
| Backup encryption | at rest + in transit, always | keys via secret manager/KMS (OQ-06) |
| Restore-test cadence | **monthly drill**, timed + documented | untested backups don't exist |

## 2. PostgreSQL

- **Continuous WAL archiving** → PITR to any point (bounds the RPO).
- **Nightly base backups**, retained per schedule (e.g. 14 daily / 8 weekly / 12 monthly — finalize with retention/compliance map §8).
- **Cross-region and off-provider copy:** at least one backup target outside the primary provider/account blast radius (guards against account compromise/ransomware, §7).
- Standby replica for fast failover (RTO path) — failover ≠ backup; both exist.
- Backup integrity: checksums on every artifact; automated periodic restore-verify (§9).
- Restores go to an isolated environment first; **prod data never restored into staging/dev** (`environments-and-flavors.md` §4).

## 3. Redis — explicitly rebuildable

**Rule 7 (⛔): Redis never holds financial truth.** Therefore Redis gets no backups; losing it is an availability event, never a money event.

On total Redis loss:

| Lost | Recovery |
|---|---|
| Hot game state / replay ring buffers | matches recover from PG `game_events` + `game_snapshots` (crash-recovery path, P6); unrecoverable in-flight hands → **void + refund via reversal**, audit-logged (poker: stacks as of hand start) |
| Matchmaking queues, seat reservations | rebuilt empty; players re-queue; reservation TTLs simply vanish (buy-ins live in PG escrow — reconciliation confirms no stuck escrow) |
| Session cache, WS adapter state, rate-limit counters | rebuilt from PG / re-auth on reconnect; rate limits restart cold |
| BullMQ jobs | re-enqueued from PG state machines (jobs only *drive* transitions; state is in PG); all jobs idempotent |

**Player-visible impact (documented honestly):** everyone disconnects; some hands/rounds void with refunds; queues clear; a few minutes of degraded login while caches warm. No balance is ever wrong. Runbook i.

## 4. Secrets & keys

| Asset | Backup posture |
|---|---|
| Secret manager (OQ-06) | provider-HA; break-glass export of critical secrets to offline encrypted storage per custody rules; inventory list maintained |
| **Prod APK signing key** | offline copies per custody runbook d (quorum-held, geographically split). **Loss = catastrophic for off-store updates** — §7 |
| Manifest-signing / pin-update keys | same custody + escrow class as the APK key |
| PII/KMS encryption keys | provider KMS with rotation; loss = crypto-shredded data, so escrow per provider best practice |

## 5. Config & infra as code

Everything recreatable from the repo: Terraform (or equivalent, OQ-06) for infra; DB-backed platform config (flags, jurisdiction config) lives in PG and rides its backups. **Terraform state protection:** versioned, locked, encrypted remote state, separate per environment, restricted access — state is as sensitive as the infra it describes. GitHub is not the only copy of the repo: mirrored on schedule to an independent location (ransomware/account-compromise hedge).

## 6. Disaster scenarios

| Scenario | Response summary | Runbook |
|---|---|---|
| Region loss | fail over PG to replica/restore in secondary region; repoint via DNS/WAF; Redis cold-start (§3); verify reconciliation before reopening money ops | h |
| PG corruption (logical/physical) | freeze writes (maintenance kill-switch), PITR to pre-corruption point, replay/void per game-event recovery, reconcile, document data-loss window vs RPO | h, g |
| Ransomware / repo or account compromise | isolate; restore from **off-provider** copies (§2) + repo mirror (§5); full secret rotation (runbook b); forensic before reconnect | b, k |
| **Signing-key loss** | without the key, no update installs over existing app — with 100% off-store distribution this bricks the upgrade path. Mitigations (built day one): escrowed offline copies (§4); **updater supports key rotation from day one** — signed key-rotation message lets a still-held key introduce a successor; worst case: new applicationId migration (new install + account continuity server-side) — documented as last resort | d |
| Signing-key **compromise** (worse than loss) | emergency forced update signed with rotated key before attacker ships a trojaned "update"; runbooks b + f end-to-end | b, f |
| WAF/DNS account compromise | registrar + WAF provider lockdown (hardware-key admin accounts, registry lock); traffic re-route; treat as full secret-leak event; pinning limits API MITM blast radius (clients reject forged certs) | k, b |
| Backup system failure (silent) | §9 automation pages on stale/unverifiable backups — this scenario is prevented, not responded to | — |

## 7. Why signing-key custody is a DR concern

Off-store distribution (ADR-017) means **no store to re-list under** — the APK signature *is* the app's identity on every installed device. Key custody (runbook d) is therefore critical infrastructure on par with the ledger. The updater's day-one support for manifest/pin/signing key rotation (`distribution-and-updates.md` §1) exists precisely so key events are survivable.

## 8. Data deletion vs backups (GDPR-class erasure)

Tension: erasure requests vs immutable backups + AML retention holds (`../06-compliance/kyc-aml.md` §6). Documented approach, **finalized at P15** with counsel:

- Live-system erasure: crypto-shredding preferred — PII encrypted per-user (key destroyed on erasure) so backups containing ciphertext become unreadable without per-backup rewrites (`../02-domains/users.md` §6).
- Backups: not rewritten; **excluded-from-restore list** maintained — any restore replays pending erasures/holds before the system returns to service (a step in runbook h).
- Legal holds (AML/tax) beat erasure for the held records, per regime — config from `../06-compliance/jurisdiction-matrix.md` §3.

## 9. Backup verification automation

- Every backup artifact: checksum recorded + verified on write and on schedule.
- **Periodic automated restore** (at minimum monthly, mirroring the manual drill): restore latest base + WAL replay into an isolated env; run smoke checks — migrations current, row-count sanity, **ledger invariants (sum-zero, balance==derived)**, audit-chain verification; report timing (RTO evidence).
- Staleness monitors: WAL archive lag, last-successful-base-backup age, off-provider copy age — all page (`observability.md` §5).
- Drill log (date, duration, issues) kept in ops records; P14 uses it to fix the final RTO number.
