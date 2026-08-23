# Threat Model

STRIDE-organized threat model for the platform described in `../01-architecture/system-architecture.md`. Normative companions: `../00-project/system-rules.md` (rules 1–3 especially), ADR-006 (server authority), ADR-013 (network security), ADR-017 (distribution), ADR-018 (risk engine). Mitigations cross-reference the sibling `04-security/` docs; this doc is the index they hang off.

**Framing (rule 1/3):** the client is compromised by definition. Every client-side control is a cost-raiser producing risk signals; the security boundary is always the server. Nothing below claims to *prevent* reverse engineering — controls raise attacker cost and improve detection.

## 1. Assets

| # | Asset | Where it lives | Compromise means |
|---|---|---|---|
| A1 | Funds / ledger integrity | PG ledger tables (`../02-domains/wallet.md`) | Direct monetary loss, insolvency, license loss |
| A2 | Credentials & sessions | `auth_credentials`, `sessions`, `refresh_tokens`, Redis caches | Account takeover → A1, A5 |
| A3 | Hidden game info (hole cards, unrevealed RNG) | Server memory, PG `game_events`, Redis hot state | Game integrity destroyed; undetectable player loss |
| A4 | RNG integrity (seeds, draw stream) | `RngService`, commit-reveal seeds | Predictable outcomes = silent theft; cert failure |
| A5 | PII / KYC data (P16+) | PG (encrypted at rest), KYC provider | Legal liability, identity theft, license loss |
| A6 | Signing keys (JWT ES256, APK signing, manifest/pinning-update keys, webhook secrets) | Secret manager; APK+pinning keys offline/HSM | Impersonation of us at every trust point |
| A7 | Admin access | Admin module, `apps/admin`, RBAC roles | Everything: A1–A6 via legitimate tooling |
| A8 | Update channel (APK hosting, manifest, forced-update path) | Own domain + CI pipeline (P13) | Malware delivery to entire user base; rule 17 broken |
| A9 | Availability (API, WS, PG, Redis) | Infra | Revenue loss; forced voids; reputational damage |

## 2. Trust boundaries

| ID | Boundary | Crossing |
|---|---|---|
| TB1 | Device ↔ WAF/CDN ↔ API ↔ data tier | All player traffic (REST + WS); the primary hostile boundary |
| TB2 | Admin plane | Admin SPA ↔ admin module; operators are semi-trusted (insider risk) |
| TB3 | Third-party webhooks | PSP/KYC → API (P16/P17); external systems asserting money/identity facts |
| TB4 | APK distribution channel | CI → hosting → device install; and hostile re-distribution outside our channel |

## 3. STRIDE by boundary

### TB1 — Device ↔ WAF ↔ API ↔ data (player plane)

Compromised-client scenarios are first-class here: assume a decompiled, re-signed, Frida-instrumented client for every row.

| S/T/R/I/D/E | Threat | Actor | Vector | Impact | Mitigations | Residual risk |
|---|---|---|---|---|---|---|
| S | Credential stuffing / brute force | Bot operator | Leaked cred lists vs `/auth/login` | Account takeover (A2→A1) | Argon2id, lockout curve, per-IP/device buckets, WAF, breach-screening (`./authentication-security.md §3`) | Slow, distributed stuffing below thresholds |
| S | Stolen refresh token replay | Malware, network attacker | Exfiltrated token used off-device | Session hijack | One-time rotation + reuse detection → family revocation; hashed at rest; device-bound signing (`./authentication-security.md §4–5`) | Window before first reuse detection |
| S | Replayed/forged financial requests | Modified client, MITM holder of a bearer token | Re-sent or crafted signed calls | Duplicate credits/debits | Request signing (nonce+timestamp), idempotency keys, server-side validation (`./financial-security.md §3`) | Fully compromised device signs what malware asks |
| S | Session fixation / WS ticket theft | Network attacker | Reused handshake material | Socket hijack | One-time 30s GETDEL tickets bound to session+device; no JWT in WS URL (`./authentication-security.md §6`) | Negligible beyond device compromise |
| S | Emulator farms & multi-accounting | Abuse rings | Many synthetic devices/accounts | Bonus/faucet abuse, collusion cover | Device/IP graphs, hardening signals, velocity rules (`./mobile-app-hardening.md`, `../02-domains/fraud-risk.md`) | Determined farms with residential proxies + real devices |
| T | Modified re-signed APK ("mod") | Skilled hobbyist → pro | Decompile, patch, re-sign, run | Automated play, probing, UI lies to its user | Server authority for all outcomes (rule 2); signature self-check + hardening signals → risk engine; server-side validation of every action | Client-side checks patchable by definition — accepted; server boundary holds |
| T | Frida/Xposed instrumentation | Skilled attacker | Runtime hooks automating play, probing hidden state | Botting; attempted info disclosure | Hook detection signals (`./mobile-app-hardening.md §5`); `playerView` guarantees nothing hidden reaches the client to hook (`./game-security.md §5`) | Botting with humanlike pacing; caught only behaviorally |
| T | MITM vs TLS/pinning | Network attacker, researcher | Rogue CA, proxy, pin-strip patch | Traffic inspection/tamper | TLS 1.2+/1.3, SPKI pinning + backup pins (`./network-security.md §2–3`) | Attacker patching pinning out of own client (their traffic only — server still validates) |
| T | Parallel-spend race | Scripted client | Concurrent buy-ins/withdrawals | Overdraw/double-spend | Ordered row locks, non-negative constraints, single-tx ops, race tests (`./financial-security.md §4`) | None accepted; test evidence required per phase |
| R | Player denies action/outcome | Any player | "I never bet that" disputes | Support load, chargebacks (P17) | Append-only `game_events` + audit log, seq-acked protocol, RNG draw audit (`./game-security.md §2`) | Social-engineering disputes |
| I | Hostile reconnect/resume probing | Modified client | `resume(matchId, lastSeq)` fuzzing, forged room joins for others' data | Hole-card leak (A3) | Resume rebuilds from `playerView` only; room auth on join; resync leak tests mandatory (`./game-security.md §5`) | Implementation bugs — mitigated by adversarial test suite (P9) |
| I | Hidden-state inference via timing/shape | Sophisticated player | Response-size/latency side channels | Partial info leak | Constant-shape responses where hidden info could be inferred (`./game-security.md §6`) | Fine-grained timing channels; monitored, accepted at launch |
| I | Error/response internals leakage | Anyone | Verbose errors, stack traces | Recon for other attacks | Enveloped error model (P1), checklist item A.7 (`./security-checklist.md`) | Low |
| D | Volumetric DDoS / WS connection floods | Anyone | L3/4/7 floods, handshake storms | A9 outage | WAF/CDN front, origin unreachable directly, edge+app rate limits, WS ticket gate (`./network-security.md §4–5`) | Large L7 attacks degrade; accepted with runbook |
| D | Expensive-endpoint abuse | Scripted client | Hammering matchmaking, history queries | Resource exhaustion | Endpoint-class rate limits, pagination, queue backpressure | Low |
| E | Client-claimed entitlements/balances | Modified client | Sending forged state/amount fields | Privilege/funds escalation | Server never trusts client values (rule 2); deny-by-default authz; contract validation | None accepted |
| E | Faucet/bonus abuse (test currency) | Multi-accounters | Farming `TST` faucet | No direct loss pre-launch, but pollutes economy + rehearses real abuse | Faucet limits, velocity rules, device graphs; treated as risk-signal rehearsal (`./financial-security.md §8`) | Accepted nuisance pre-launch |
| E | Poker collusion rings / chip dumping | Organized players | Coordinated play, deliberate losses | Theft from honest players (A1/A3-adjacent) | Server-side detection heuristics, table co-occurrence graphs, review queues (`./game-security.md §8`, `../02-domains/fraud-risk.md`) | Skilled low-volume collusion; improves with data (P10+) |

### TB2 — Admin plane

| S/T/R/I/D/E | Threat | Actor | Vector | Impact | Mitigations | Residual risk |
|---|---|---|---|---|---|---|
| S | Admin credential theft | Phisher, malware | Stolen password | A7 → everything | Mandatory TOTP 2FA, IP allowlist option, stricter TTLs (`./authentication-security.md §9`) | 2FA-bypassing real-time phish; hardware keys are the P12+ upgrade path |
| T/E | Insider abuse (rogue operator) | Employee/contractor | Legitimate tooling misused: adjustments, freezes, PII pulls | Fraud, data theft | RBAC least privilege, four-eyes on adjustments + `compliance.real_money_enabled`, immutable hash-chained audit incl. PII read-audits, app DB role cannot UPDATE/DELETE ledger (`./financial-security.md §9`) | Colluding pair of insiders; periodic audit review |
| R | Operator denies action | Insider | — | Disputes | Hash-chained audit log per action (rule 15) | Low |
| I | Admin data exposure | Attacker on operator device | Session/browser compromise | PII/KYC leak | Short sessions, re-auth for sensitive views, read-audit, least-data screens | Endpoint compromise of operator machines — org policy territory |
| D | Lockout of admins | Attacker or accident | Mass revocation, IP-allowlist mistakes | Ops blindness during incident | Break-glass procedure in `../07-operations/runbooks.md` | Low |

### TB3 — Third-party webhooks (PSP/KYC, P16/P17)

| S/T/R/I/D/E | Threat | Actor | Vector | Impact | Mitigations | Residual risk |
|---|---|---|---|---|---|---|
| S | PSP webhook forgery | Attacker knowing endpoint | Crafted "deposit succeeded" POST | Free ledger credits (A1) | Signature verification before any state change (rule 8), IP allowlists where supported, separate ingress path (`./network-security.md §6`, `./financial-security.md §5`) | Compromised provider-side secret → rotation runbook |
| T | Webhook replay | Same | Re-sent legitimate events | Duplicate credits | Idempotency by provider event id (unique constraint) | None accepted |
| S | Provider account takeover | Attacker at provider | Provider dashboard compromise | Redirected payouts | Provider 2FA, payout destination verification, reconciliation vs statements | Partially outside our control; reconciliation is the detector |
| D | Webhook floods | Anyone | Spam to webhook path | Queue pressure | Separate rate class, queue isolation | Low |

### TB4 — APK distribution channel (P13)

| S/T/R/I/D/E | Threat | Actor | Vector | Impact | Mitigations | Residual risk |
|---|---|---|---|---|---|---|
| T | Hosting compromise serving malicious APK | Server attacker | Replace hosted APK | Mass malware (A8) | Android signature continuity on update installs; signed manifest verified against pinned key before install prompt; SHA-256 checksums; CI-only publish path (ADR-017) | First-installs by new users during a compromise window; monitoring + rapid response |
| S | Malicious "modded APK" redistributed to victims | Scammer | Fake sites/Telegram offering "hacked client" | Victim credential theft, our brand damage; victims' devices, not our servers | Official-channel comms in app + site, takedown monitoring, signature self-check signal identifies modded installs that do connect, user education | Cannot prevent third-party hosting; detection + response only |
| T | Update-manifest tampering | MITM/host attacker | Altered version/URL/checksum | Malicious update or forced-update bypass | Manifest signed by offline key, verified against pinned public key in app; pinned TLS on update endpoint | Offline-key compromise → `./secrets-management.md` custody + `../07-operations/runbooks.md` |
| D | Breaking the forced-update path | Ourselves (regression) | Bad release of version-check flow | Unpatchable fleet (rule 17) | Update-path e2e tests every release; version-check endpoint frozen semantics; staged rollout | Treated as top-tier engineering risk, not accepted silently |
| S/T | Secret leakage via repo/CI | Developer error, CI attacker | Committed secret, exfiltrated CI env | A6 → many boundaries | Rule 14, gitleaks in CI + history scans, environment-scoped GitHub secrets, OIDC over long-lived keys (`./secrets-management.md §5–6`) | Human error; detection + rotation runbook bound the blast radius |

## 4. Top-10 ranked risks

Ranked by (impact × likelihood), given a server-authoritative design; ranking assumes real money enabled (P18) except where noted.

| Rank | Risk | Boundary | Primary defenses | Verification |
|---|---|---|---|---|
| 1 | Ledger corruption via race/logic bug (self-inflicted or provoked) | TB1 | Append-only double-entry, ordered locks, idempotency, reconciliation paging | P4 concurrency test evidence; continuous invariant monitoring |
| 2 | PSP webhook forgery/replay → free credits | TB3 | Signatures, event-id idempotency, reconciliation | P17 forgery/replay tests |
| 3 | Insider abuse of admin plane | TB2 | RBAC, four-eyes, immutable audit, DB privilege split | P12 RBAC matrix tests, audit review |
| 4 | Hole-card / hidden-state leak (incl. resync paths) | TB1 | `playerView`-only serialization, adversarial protocol tests | P9 leak-test suite green |
| 5 | Update-channel compromise or forced-update breakage | TB4 | Signed manifest + pinned key, signature continuity, update e2e per release | P13 tamper-rejection tests |
| 6 | Account takeover at scale (stuffing, stolen refresh) | TB1 | Rotation+reuse detection, lockout curve, device binding | P3 attack tests |
| 7 | Collusion/chip-dump theft from players in poker | TB1 | Detection heuristics, review queues, hand-history analysis | P10 synthetic-scenario detection |
| 8 | Signing-key or secret leakage (repo/CI/infra) | TB4/all | Rule 14, secret manager, scanning, custody ceremonies | gitleaks green; custody checklist (P14/E-gates) |
| 9 | DDoS / WS exhaustion at launch | TB1 | WAF, rate tiers, load-tested capacity | P14 load + chaos evidence |
| 10 | RNG weakness or predictability claim | TB1 | CSPRNG-only, audit-logged draws, commit-reveal, certification (ADR-016) | P6 draw-audit tests; P18 cert |

## 5. Review cadence

- **Per phase:** every phase plan's §15 (security) is reviewed against this doc — new endpoints/events/tables mapped to boundaries, new threats added here in the same PR (`./security-checklist.md` item A.9).
- **Per new game:** the game's phase reviews TB1 game rows + `./game-security.md`.
- **P14:** full re-walk with the pen-test scope derived from §3–4; pen-test findings feed back into rankings.
- **P15–P18:** TB3 rows become concrete once OQ-02/03 pick providers; re-rank §4 before enabling `compliance.real_money_enabled`.
- **On incident:** post-mortem must state which threat row fired (or add the missing one).
