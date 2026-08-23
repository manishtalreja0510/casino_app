# Responsible Gaming — Obligations Matrix

> Planning-grade; **verify with counsel — not legal advice.** Regime columns are *classes*, not chosen jurisdictions (OQ-01 open). Mechanism lives in `../02-domains/responsible-gaming.md`; this doc maps obligations → implementation → phase. Filled with verified values for the chosen regime(s) at **P15**, completed/verified at **P18**.

**Design principle (normative): build to the strict end where cheap, configure downward.** Every feature below is built once at the strict-regime shape (server-side, non-bypassable, evidence-producing) with jurisdiction config selecting the mandated subset/defaults. Loosening is a config change; tightening late would be a rebuild.

## 1. Obligations matrix

Requirement levels: **M** = typically mandated · **E** = typically expected/good practice · **O** = optional/absent. *Indicative — verify per regime with counsel.*

| RG feature | Strict regime (UK-class) | Mid regime (MGA-class) | Light regime (Curaçao-class) | Our implementation (`../02-domains/responsible-gaming.md`) | Phase |
|---|---|---|---|---|---|
| Deposit limits | **M** (offered; mandated defaults in some strict regimes) | **M** (offered) | E | `rg_limits` type=deposit; faucet stand-in pre-P17 (§3) | P10 baseline / P17 bind / P18 defaults |
| Loss limits | **M** offered | **M** offered | E | `rg_limits` type=loss, metered in-transaction (§3) | P10 / P18 |
| Wager limits | E–M | E | O | `rg_limits` type=wager (§3) | P10 / P18 |
| Session-time limits | **M** offered | E | O | `rg_limits` type=session_time via server timer framework (§3) | P10 / P18 |
| Limit change asymmetry (decrease now / increase after cooling) | **M** | **M** | E | `pending_increase` + `rg.limit_increase_cooling_hours` (§3) | P10 |
| Reality checks | **M** (interval bounds prescribed) | **M**–E | O | server-pushed WS check, must-acknowledge (§4) | P10 / P18 intervals |
| Cool-off | **M** | **M** | E | `rg_exclusions` kind=cool_off (§5) | P10 |
| Self-exclusion | **M** | **M** | **M** (under LOK) | `rg_exclusions` kind=self_exclusion, never lifted early (§5) | P10 / P18 |
| **National register integration** (GAMSTOP-class) | **M** where register exists | O (no register) | O | `rg.register_integration` config + regulator-list exclusion source (§5); adapter built only if chosen regime has a register | P18 |
| Age verification | **M** before play | **M** (before withdrawal / deadline-bound) | **M** (lighter evidence) | KYC L1 predicate (§7); DOB placeholder until P16; `rg.age_gate_free_play` for regimes gating free play | P10 placeholder / P16 real / P18 config |
| RG messaging & helplines | **M** (prescribed content/placement) | **M** | E | notifications non-optoutable RG class + static RG screens; content per-jurisdiction config | P10 scaffold / P18 content |
| Staff RG processes (interaction on markers of harm) | **M** | E | O | risk-engine markers-of-harm rules → admin review queue + case notes (P12); intervention playbook | P10 signals / P12 queue / P18 playbook |
| Marketing restrictions (inducements, bonus terms, no marketing to excluded/limited) | **M** (strict) | **M** | E | `marketing.restrictions` config; excluded users auto-suppressed in `notifications` | P11 / P18 |
| **Affordability checks** (strict regimes) | **M** (threshold-triggered financial risk checks) | O–E | O | risk-engine trigger → L2/SOF flow (`kyc-aml.md` §5); thresholds config | P18 (config exists P10) |
| Mandated default limits for young adults / vulnerable groups | M in some strict regimes | O | O | `rg.mandated_limit_defaults` keyed by age band | P18 |

## 2. Phase split (contract with the roadmap)

| Phase | RG deliverable |
|---|---|
| **P10 (baseline)** | Whole mechanism live on test currency: all four limit types, asymmetric changes, reality checks, cool-off, self-exclusion, enforcement at every point (`responsible-gaming.md` §6), DOB placeholder gate, `rg_events` evidence trail |
| P11/P12 | RG notification class; admin tooling (no loosening powers) |
| P15 | Chosen regime(s) → this matrix reduced to verified values; config keys filled (`jurisdiction-matrix.md` §3) |
| P16 | Real age verification (KYC L1) |
| P17 | Deposit limits bind to real deposits; withdrawal-while-excluded per `rg.withdrawal_while_excluded` |
| **P18 (completion)** | Mandated defaults, prescribed messaging/helplines, register integration if applicable, affordability triggers, regulator-facing RG reporting (`licensing-requirements.md` §4) — verified against license conditions before `compliance.real_money_enabled` flips |

## 3. Evidence

Every obligation above must be *provable*: `rg_events` (append-only) + audit log (rule 15) are the evidence substrate; RG reports for regulators are exports over them (`licensing-requirements.md` §4). A feature that works but can't be evidenced fails P18 review.
