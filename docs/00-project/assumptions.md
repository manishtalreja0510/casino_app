# Assumptions

Working assumptions the plan rests on. Each: statement, basis, impact if wrong, where it is tested or revisited. An assumption is not a decision — where one overlaps an OQ, the OQ owns resolution. If one falls, update the linked docs and record fallout in `docs/progress.md`.

## A-01 — Licensing is obtainable in an acceptable jurisdiction (OQ-01)
- **Statement:** at least one target market exists where we can obtain a license on acceptable cost/timeline (offshore or national route).
- **Basis:** established regimes (MGA, IoM, Curaçao LOK, national licenses) license comparable operators routinely.
- **Impact if wrong:** no real-money product, ever — P15–P18 never execute. Sunk cost is bounded by design: a complete test-currency platform remains (strategic bet 3, `vision.md`); pivot options (social/sweepstakes model) would need their own legal review as a candidate OQ.
- **Tested/revisited:** business track from day 0 (OQ-11 → OQ-01); hard checkpoint at P15.

## A-02 — A gambling-tolerant PSP will accept us post-license (OQ-02)
- **Statement:** with a license in hand, at least one specialist PSP/aggregator accepts the merchant account with payout API + signed webhooks + statement API.
- **Basis:** gambling-specialist PSPs exist precisely for this MCC; license-first is their standard prerequisite.
- **Impact if wrong:** deposits/withdrawals impossible → no revenue (standing risk #2). Mitigation already built in: `PaymentProviderPort` is PSP-agnostic, multi-PSP-ready.
- **Tested/revisited:** PSP shortlisting in the P15 track; contract + sandbox access is a P15 acceptance criterion.

## A-03 — Android sideload users tolerate off-store install friction
- **Statement:** the target audience will enable unknown-source installs, download our APK, and complete in-app updates at acceptable conversion.
- **Basis:** established precedent — real-money operators in many markets distribute off-store for policy reasons; the audience self-selects.
- **Impact if wrong:** acquisition/retention funnel underperforms; forced-update compliance lags. Fallbacks: better guided install/download page (P13 scope), revisit store distribution per market post-OQ-01, raise priority of OQ-04-style alternatives. Architecture is unaffected.
- **Tested/revisited:** install/update funnel metrics from first staging distributions (P13); forced-update e2e every release.

## A-04 — Most target devices have Google Play services (OQ-09, OQ-12)
- **Statement:** the large majority of target devices are Play-services devices, so FCM push and Play Integrity signals cover most of the fleet.
- **Basis:** Play services ships on nearly all non-Chinese-market, non-de-Googled Android devices.
- **Impact if wrong:** push coverage and one risk signal degrade. Already designed for: nothing critical is push-only (REQ-NTF-03, in-app WS baseline), Play Integrity is one weighted signal never a gate (OQ-12); self-hosted push (UnifiedPush/ntfy) is the documented fallback.
- **Tested/revisited:** device telemetry once real fleet exists; OQ-09 revisited if de-Googled share proves material.

## A-05 — Team stays small through launch
- **Statement:** a small team (single-digit engineers) builds and operates the platform through P18.
- **Basis:** current plan and funding posture.
- **Impact if wrong (bigger):** monolith module boundaries are the seams — extraction is a deployment change (ADR-003, `system-architecture.md §8`); re-cut phase parallelism. **If smaller:** timeline stretches; phase order already front-loads irreversible correctness work.
- **Tested/revisited:** drives ADR-003 (modular monolith), OQ-06 recommendation (managed infra over self-run Vault/K8s); revisit at each phase plan.

## A-06 — Test-currency gameplay requires no gaming license where we build and test
- **Statement:** running the platform on `TST` credits (no deposits, no real-money prizes, faucet-funded) is not licensable gambling in the locations where the team develops and tests.
- **Basis:** no consideration/prize in real money; common industry treatment of play-money products. **This is a legal question, not an engineering one — verify with counsel (OQ-11 engagement), including marketing/promotion of the test build.**
- **Impact if wrong:** even test builds become jurisdiction-restricted → geo-fence test distribution, restrict staging access, possibly relocate testing. Compliance gate + geo-fencing capability from day one bound the blast radius.
- **Tested/revisited:** explicit counsel question at OQ-11 engagement; before any public/invited test distribution (P13).

## A-07 — Socket.IO + Redis adapter scales to launch targets
- **Statement:** the ADR-007 stack sustains ~5k concurrent WS connections / ~500 concurrent tables with REQ-NFR-02 latency.
- **Basis:** well within documented Socket.IO + redis-adapter deployments; targets are modest.
- **Impact if wrong:** swap transport (raw ws/uWebSockets) behind the realtime module, or extract realtime+engine early (the planned first extraction seam) — protocol (seq/resume, tickets, rooms) is transport-portable by design.
- **Tested/revisited:** load harness starts in P5; validated as a hard gate in P14.

## A-08 — Designers arrive after core build
- **Statement:** no product designer is available before the platform phases; design lands as late restyle (P19).
- **Basis:** hiring plan; P19 explicitly blocked on designer onboarding.
- **Impact if wrong (earlier arrival):** pure upside — P19 can start parallel to P10+ as planned; tokens/ui_kit absorb work immediately. **If never:** placeholder theme ships polished-plain; competitive weakness, not a rebuild.
- **Tested/revisited:** drives ADR-019 and rules 25–27 (placeholder-first, tokens-only, thin screens); P19 acceptance audits that restyle touched no logic.

## A-09 — Fiat-only at launch (OQ-08)
- **Statement:** launch currencies are fiat, per target market; no crypto rails.
- **Basis:** crypto pre-license worsens AML burden, PSP acceptance, and is prohibited in candidate regimes (OQ-08).
- **Impact if wrong (crypto required by market reality):** ledger is already multi-currency; a crypto rail would enter as another `PaymentProviderPort` adapter + heavy AML/KYT config — new ADR required.
- **Tested/revisited:** OQ-08 at P15 with counsel.
