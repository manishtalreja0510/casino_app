# Jurisdiction & Licensing Decision Matrix (OQ-01)

> **DISCLAIMER — read first.** This document requires review by **qualified gaming counsel** (OQ-11). It *structures* the OQ-01 decision; it does **not** make it. All values are **indicative, planning-grade, and must be verified with counsel** — regulations in this sector change quarterly. Nothing here is legal advice. No jurisdiction is chosen by this document; engineering remains jurisdiction-agnostic and every jurisdiction-dependent behavior is configuration (§3).

Status: **OPEN — blocked on OQ-01 / OQ-11.** Filled-for-real at **P15**. Referenced by: `kyc-aml.md`, `responsible-gaming-obligations.md`, `licensing-requirements.md`, `../02-domains/kyc-verification.md`, `../02-domains/responsible-gaming.md`, `../00-project/open-questions.md`.

## 1. Candidate regimes — matrix

Rows = candidate regimes counsel should evaluate. Two prohibited-market rows anchor what geo-fencing must block regardless of choice. All cells: *verify with counsel — planning-grade, not legal advice.*

### 1a. Licensing, KYC, AML, fairness, RG

| Regime | License cost / timeline class | KYC depth required | AML thresholds regime | RNG certification (GLI-19-class) | RG obligations level |
|---|---|---|---|---|---|
| **Malta (MGA)** | High: ~€25k application + annual fees + compliance contribution; 6–12 months | Full CDD; identity + age before withdrawal, verification deadlines on deposit | EU AMLD-derived; EDD at ~€2,000 cumulative; risk-based ongoing monitoring | **Required** — MGA-approved lab, GLI-19-class + system audit | Mid-high (limits, self-exclusion, RG messaging; MGA player-protection directives) |
| **Isle of Man (GSC)** | Mid-high: ~£5k app + ~£35k+/yr; 4–6 months | Full CDD; risk-based timing | Strong AML/CFT code; threshold-triggered EDD, SOF checks | **Required** — accredited lab certification | Mid (self-exclusion, limits offered; less prescriptive than UK) |
| **Curaçao (LOK, post-2024)** | Low: application + annual in low-tens-of-k USD class; weeks–months | Mandated under LOK but lighter depth in practice | Basic and tightening; operator AML policy required | Required on paper under LOK; enforcement maturing — plan for full cert anyway | Light and tightening (self-exclusion + basic duties under LOK) |
| **UK (Gambling Commission)** | High: fees banded by GGY; 4–6 months application, heavy ongoing burden | **Strictest**: age + identity verified **before** any gambling/deposit | Risk-based (POCA/MLR) — no safe fixed threshold; affordability/SOF interactions | **Required** — GC-approved test house vs Remote Technical Standards (RTS) | **Strictest** (GAMSTOP national register, affordability checks, marketing rules, credit-card ban) |
| **Ontario (AGCO / iGaming Ontario)** | High: ~CA$100k/yr regulatory fee class + iGO commercial terms; several months | Full identity + age before play | FINTRAC regime: CA$10k reporting, LCTR/STR duties | **Required** — AGCO explicitly references GLI-19-class standards, approved labs | High (centralized self-exclusion direction, strict marketing/inducement rules) |
| **Local-market license (generic row)** | Per market — often highest per-capita cost | Per market | Per market | Usually required | Per market (assume UK-class until shown otherwise) |
| **PROHIBITED — India** | — **Online Gaming Act 2025: outright ban on real-money online games**, regardless of skill/chance argument | N/A — do not serve | N/A | N/A | N/A — **geo-block from day one** |
| **PROHIBITED — USA (unlicensed), China, most Gulf states** | USA: state-by-state; unlicensed operation is a felony-class exposure. China, most Gulf states: prohibited | N/A — do not serve | N/A | N/A | N/A — **geo-block from day one** |

### 1b. Data protection, tax, PSP, poker, geo, banking (same rows)

| Regime | Data-protection law | Tax treatment class | PSP availability | Poker skill-game treatment | Geo-fencing obligations | Reputation / banking friction |
|---|---|---|---|---|---|---|
| **Malta (MGA)** | GDPR | ~5% gaming tax on Malta-based players + tiered compliance contribution; corporate structures common | Good — most gambling PSPs accept MGA | Regulated gambling (licensed game type); no skill carve-out benefit | Must block prohibited/sanctioned markets; MGA expects market-entry legality checks | Good; banking workable |
| **Isle of Man (GSC)** | GDPR-equivalent (IoM law, UK-adequacy class) | Low: 0.1–1.5% GGY duty class | Good | Regulated gambling | Must not serve prohibited markets | Good |
| **Curaçao (LOK)** | Local law, light; GDPR applies anyway if serving EU residents | Low: ~0% gaming tax class + modest profit tax | **Limited** — high-risk PSPs only; mainstream acquirers rare | Treated as gambling; no practical distinction | Blocklist duty (prohibited-jurisdiction list under LOK) | **Weak reputation; high banking friction** — factor into OQ-02 |
| **UK (GC)** | UK GDPR | ~21% Remote Gaming Duty on GGY | Excellent (but credit cards banned for gambling) | Gambling (poker explicitly regulated) | License covers GB only; serving elsewhere needs that market's license | Excellent |
| **Ontario (AGCO/iGO)** | PIPEDA + Ontario rules | ~20% revenue share to iGO class | Good | Gambling; **player liquidity ring-fenced to Ontario** (kills shared poker pools) | Strict: Ontario players only, geolocation verification expected | Good |
| **Local-market (generic)** | Per market (assume GDPR-class) | Per market | Per market | **Varies — the one regime class where "skill game" may matter; counsel question per market** | Per market | Per market |
| **PROHIBITED rows** | N/A | N/A | N/A | Irrelevant — ban applies regardless (explicit in India's 2025 Act) | **Our obligation: block these from every licensed deployment** | N/A |

**Reading the matrix.** No row dominates. The classic trade-off: Curaçao-class = fast/cheap but PSP/banking pain (directly worsens OQ-02) and tightening rules; MGA/IoM-class = credible and PSP-friendly but slow/costly; UK/Ontario-class = direct market access at the heaviest compliance load; multi-market = local license per market anyway. Counsel shortlists 2–3 against the target-market list; decision recorded in `../00-project/open-questions.md` at P15.

## 2. Engineering consequences per column

| Matrix column | Drives (doc) |
|---|---|
| KYC depth | level requirements/doc sets — `kyc-aml.md`, `../02-domains/kyc-verification.md`, OQ-03 |
| AML thresholds | KYT threshold config — `kyc-aml.md`, `../02-domains/fraud-risk.md` |
| RNG certification | lab engagement + change control — `licensing-requirements.md`, ADR-016 |
| RG obligations | defaults/mandates — `responsible-gaming-obligations.md`, `../02-domains/responsible-gaming.md` |
| Data protection | retention, residency, erasure — `kyc-aml.md` §7, `../07-operations/backup-disaster-recovery.md` §8, OQ-10 residency |
| Tax treatment | ledger reporting exports — `licensing-requirements.md` §4 |
| PSP availability | OQ-02 shortlist feasibility — ADR-014 |
| Poker treatment | whether poker ships in market at all — OQ-07 scope |
| Geo-fencing | enforcement config — §3 below, P18 |

## 3. Jurisdiction variables that MUST be configuration

Everything below is a config key set (per-jurisdiction config record, DB-backed, admin-managed at P15+, four-eyes). Code references keys, **never literals** (system-rules 11, 24). Owning doc = where semantics are defined.

| Config variable | Owning doc |
|---|---|
| `geo.allowed_countries` / `geo.blocked_countries` (deny-by-default) | `../01-architecture/security-architecture.md`, P18 enforcement |
| `kyc.required_level_per_action` (deposit/withdraw/play thresholds) | `../02-domains/kyc-verification.md` §3 |
| `kyc.accepted_documents`, `kyc.liveness_required`, `kyc.address_proof_required` | `kyc-aml.md` §3 |
| `kyc.reverification_interval`, `kyc.level_expiry` | `../02-domains/kyc-verification.md` §5 |
| `aml.edd_threshold`, `aml.sof_threshold`, `aml.report_thresholds`, `aml.velocity_windows` | `kyc-aml.md` §4–5, `../02-domains/fraud-risk.md` |
| `aml.record_retention_years` | `kyc-aml.md` §6 |
| `rg.mandated_limit_defaults` (deposit/loss/wager/session), `rg.limit_increase_cooling_hours` | `../02-domains/responsible-gaming.md` §3 |
| `rg.reality_check_interval_bounds`, `rg.age_gate_free_play` | `../02-domains/responsible-gaming.md` §4, §7 |
| `rg.self_exclusion_min_terms`, `rg.register_integration` (national register on/off) | `responsible-gaming-obligations.md` |
| `rg.withdrawal_while_excluded` | `../02-domains/responsible-gaming.md` §6 |
| `age.minimum` (18/19/21 by market) | `../02-domains/responsible-gaming.md` §7 |
| `games.permitted_types` (e.g. poker off in a market) | `../02-domains/game-engine.md` per-game kill-switch |
| `wallet.currencies` (real currency set, OQ-08) | `../02-domains/wallet.md` |
| `tax.report_class`, `tax.export_schedule` | `licensing-requirements.md` §4 |
| `marketing.restrictions` (inducements, bonus rules, credit-card ban class) | `../02-domains/notifications.md` |
| `data.residency_region`, `data.retention_map` | `../07-operations/backup-disaster-recovery.md`, OQ-06/OQ-10 |
| `compliance.regulator_report_endpoints` / export formats | `licensing-requirements.md` §4 |
| `rng.cert_lab`, `rng.certified_component_versions` | ADR-016, `licensing-requirements.md` §2 |

Multi-jurisdiction from day one: config is keyed by jurisdiction, resolved per user (declared address + KYC doc country + IP geo cross-check at P18); the strictest applicable value wins on conflict.

## 4. Process to close OQ-01

1. OQ-11: entity + counsel engaged (runs from P0, business track).
2. Counsel scores this matrix against the target-market list; adds/removes rows.
3. Shortlist 2–3 → PSP (OQ-02) and KYC (OQ-03) vendor soundings against shortlist.
4. Decision recorded in `../00-project/open-questions.md` (decision + date + decider); this matrix reduced to the chosen regime(s) with **verified** values; §3 config filled; ADR-014/015/016 → ACCEPTED. That is P15's exit criterion.
