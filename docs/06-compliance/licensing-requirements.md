# Licensing — Engineering Requirements

> Planning-grade; **verify with counsel — not legal advice.** What obtaining and *holding* a license demands from **engineering** (the business paperwork — entity, policies, key-person applications — is OQ-11's track). Everything here is **blocked on OQ-01** for concrete values, but the shapes below recur across every plausible regime, so they are checklist inputs to **P15** (decision) and **P18** (completion). Regime specifics: `jurisdiction-matrix.md`.

## 1. Summary checklist (P15 inputs → P18 exit criteria)

| # | Requirement | Built by | Verified at |
|---|---|---|---|
| 1 | Certified RNG + change control on certified components | P6 (`RngService` port) + lab at P18 | P18 |
| 2 | Game rules docs + RTP/fairness disclosures per game | P8/P9 (per-game rules doc) | P15 review / P18 |
| 3 | Regulator reporting/export APIs (ledger, player activity, RG) | P4/P10 substrate; exports P17–P18 | P18 |
| 4 | Technical-standards compliance testing | P14 harness reused | P18 |
| 5 | Incident/breach notification duties wired to runbooks | P14 drill | P18 |
| 6 | Key-person / system-access controls | P12 RBAC + audit | P15/P18 |
| 7 | Change-management evidence | P0 process (ADR + phases) | continuous |
| 8 | Data residency options kept open | OQ-06 decision | P15 |
| 9 | Compliance calendar (ongoing duties) | — | P18 → ops |

## 2. Certified RNG (ADR-016, PROPOSED until OQ-01)

- **Lab engagement:** GLI-19-class certification from a regime-approved lab (GLI, eCOGRA, iTech Labs, BMM class — *which* labs are acceptable is regime-dependent, OQ-01). Engage during P15 track; certification completes in **P18** for every shipped game.
- **Architecture already fits:** `ctx.rng` → `RngService` port (P6) means the certified RNG is a swap behind the port; audit-logged draws provide the evidence stream labs and disputes need; commit-reveal provable fairness is optional per game and complements, never replaces, certification.
- **Change control on certified components (the ongoing burden):** once certified, the RNG implementation, game math/payout logic, and settlement paths are **frozen components** — any change requires re-certification or lab-approved change process *before* deploy. Engineering mechanism: certified components are version-pinned (`rng.certified_component_versions` config); CI blocks release of a changed certified path without an override recorded as an ADR + compliance sign-off; the ADR+phase process (§7) is the evidence.
- Game math documentation (payout tables, house edge/rake derivation) is a lab input — written with the game (P8/P9), not reverse-engineered at P18.

## 3. Game-rules documentation & RTP/fairness disclosures

Per shipped game (P8, P9): player-facing rules page (versioned, in-app), RTP/house-edge or rake disclosure where the regime mandates it, malfunction clause ("malfunction voids play" semantics implemented as the engine's void+refund path — `../02-domains/game-engine.md`), and the internal math spec for the lab. Disclosures are content per jurisdiction config; the rendering surface is built once.

## 4. Regulator reporting & data exports

Regimes differ in format (periodic files vs API vs on-demand), not in substance. Substrate exists by P10; export jobs land P17–P18.

| Report class | Source | Notes |
|---|---|---|
| Financial/ledger (GGY, tax base, liabilities to players) | Append-only ledger (P4) | Also feeds tax filings (`tax.report_class`) |
| Player activity (registrations, actives, per-player wager/win/loss) | ledger + game_events | Anonymization/pseudonymization per regime |
| RG reports (limits set, exclusions, interventions) | `rg_events` + audit log | See `responsible-gaming-obligations.md` §3 |
| AML (threshold reports, SAR/STR support bundles) | `kyc-aml.md` §3 | Human-filed; system produces evidence bundles |
| Game fairness (RNG draw logs, RTP actuals vs theoretical) | RNG audit log, settlement records | Drift between actual and theoretical RTP is also an internal alert (`../07-operations/observability.md`) |
| Incident reports | audit log + incident timeline (runbook a) | §5 |

Design rule: reports are **read-only exports over append-only stores** — no report-specific mutable state, so numbers are reproducible for any past period.

## 5. Incident & breach notification duties

Regimes impose notification deadlines (data-protection: e.g. 72h GDPR-class; regulator: material incidents, outages affecting players, security breaches — deadlines vary). Engineering hooks: incident-response runbook (`../07-operations/runbooks.md` a) carries a **regulatory notification step blocked on OQ-01** (who, what, deadline — filled at P15); the incident timeline log is the notification's factual source; severity matrix marks which severities *may* trigger duty (breach of PII, money incorrectness, forced-update misuse, prolonged outage).

## 6. Key-person & system-access controls

Regulators vet who controls the platform. Engineering must evidence: named-role access (P12 RBAC: support/risk/finance/ops/compliance/superadmin), mandatory 2FA, four-eyes on critical actions (`compliance.real_money_enabled`, large adjustments), the append-only admin audit trail (rule 15), production access limited + logged (`../07-operations/observability.md` §7 log-access controls), and secret custody per runbooks (signing keys, DB credentials). Personal license holders (regime-dependent) map to admin roles — keep role→person mapping exportable.

## 7. Change-management evidence

Regimes expect controlled, documented change. **Our existing process is the answer, presented as such:** ADRs for architectural change (rule 19), phase plans + completion reports (rule 28), PR review + CI gates + branch protection (`../07-operations/ci-cd.md`), docs-in-sync rule (rule 29), and release versioning with signed manifests (`../07-operations/distribution-and-updates.md`). P15 deliverable: a short mapping document from regime change-control clauses → these artifacts. Certified components get the stricter path in §2.

## 8. Data residency

Some regimes require data (or a real-time replica) in-jurisdiction or regulator-accessible. Until OQ-01: keep hosting portable (containers + env injection, ADR-011 PROPOSED), no residency-hostile hard dependency; Sentry/observability residency flagged in OQ-10. At P15: `data.residency_region` set; if the regime demands in-country replica, that's an infra addition, not an app change (PG replication — `../07-operations/backup-disaster-recovery.md`).

## 9. Ongoing compliance calendar (concept)

Holding a license is recurring work. At P18 hand ops a calendar: license/fee renewals; RNG/game re-certification on change or period; periodic compliance audits (regime-dependent); AML re-screening cycles (sanctions/PEP); report submission schedules (§4); RG review cycles; pen-test cadence (annual-class, ties to P14 machinery); key rotation schedules (`../07-operations/runbooks.md` c/d). Each entry: owner role, period, evidence artifact. Tracked outside code; alerting for deadlines via the ops stack.

## 10. Explicitly out of engineering scope

Entity formation, policy manuals, key-person applications, license fees, counsel engagement — OQ-11/business track. Engineering's obligation is that **nothing above needs inventing after the license arrives**: the substrate (ledger, audit, RG events, RNG port, RBAC, runbooks) exists on test currency by P14.
