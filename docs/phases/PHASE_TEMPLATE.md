# PHASE_TEMPLATE — copy to `docs/phases/PHASE-XX-<slug>.md` before starting a phase

> Fill every section. "N/A" requires one line of justification. The plan must be validated against `docs/01-architecture/*` and `docs/00-project/system-rules.md` **before** implementation. Security considerations are mandatory for every phase, no exceptions.

# Phase XX — <Name>

## 1. Phase overview
One paragraph: what this phase is and where it sits in the roadmap (link `docs/MASTER_ROADMAP.md` entry).

## 2. Current status
`NOT_STARTED | RESEARCH | PLANNING | PLAN_REVIEW | READY_FOR_IMPLEMENTATION | IMPLEMENTING | TESTING | SECURITY_REVIEW | DOCUMENTATION | COMPLETE | BLOCKED` (+ date, and blocker/OQ ref if BLOCKED). Mirror in `docs/progress.md`.

## 3. Objective
The outcome in 1–3 sentences. What is true after this phase that wasn't before.

## 4. Dependencies
Phases (P-nn) and open questions (OQ-nn) this depends on, and their **verified** current state — do not assume the previous phase's completion; verify it (see §6).

## 5. Preconditions
Concrete checkable facts required before starting (envs available, migrations at version N, flags present, contracts published, etc.).

## 6. Existing-code analysis
What exists today that this phase touches: modules, tables, packages, screens, contracts. Verify the previous phase's deliverables actually work (run its acceptance checks if cheap). List discovered drift between docs and code — fix docs or file it.

## 7. Scope
Numbered, testable scope items. This is the approved scope; no silent expansion (rule 28).

## 8. Out of scope
Explicit non-goals someone might reasonably assume are included.

## 9. Architecture considerations
How this phase fits the architecture docs; any new ADR needed (major changes require one — rule 19); module boundaries touched; extraction-readiness impact.

## 10. Database changes
Migrations (forward + rollback note), new tables/columns/constraints, data backfills, lock/perf impact of running the migration, ownership (which module owns each table).

## 11. Backend changes
Modules/services/jobs added or changed; domain events; flag gates; idempotency and concurrency notes for anything state-changing.

## 12. Flutter changes
Screens (thin shells), providers/state, ui_kit additions (components/tokens — never one-off styled widgets), asset registry additions, router config changes. Update `docs/08-design/ui-flow-map.md` in the same PR.

## 13. API changes
REST endpoints (additive within /v1 — rule 23), contract updates in `packages/contracts`, regeneration of Dart client, error codes added.

## 14. WebSocket changes
Events (versioned), rooms, seq/resume implications, payload schemas in contracts.

## 15. Security considerations (MANDATORY)
Threats this phase introduces or touches (reference `docs/04-security/threat-model.md`); authz for every new endpoint/event; input validation; rate limits; audit events emitted; PII handling; secrets touched; items to run from `docs/04-security/security-checklist.md`.

## 16. Edge cases
Enumerate: concurrency races, crashes mid-operation, reconnects, idempotent retries, clock issues, malformed/adversarial input, empty/limit states.

## 17. Testing strategy
Unit / integration / e2e / adversarial / load items with pass criteria; which existing suites must stay green (contract conformance, ledger properties, etc.).

## 18. Implementation plan
Ordered steps with rough sizing; safe merge points; flag-gating strategy so partial work ships dark.

## 19. Rollback / recovery
How to halt or revert mid-phase: migration rollback, flag kill, data cleanup. What is NOT rollbackable and how that risk is accepted.

## 20. Acceptance criteria
Checkable statements a reviewer can verify without reading the code.

## 21. Definition of done
All acceptance criteria met · all tests green (no skips) · lint/analyze clean · security checklist items closed · docs + `progress.md` + flow map updated · completion report written · no TODOs without linked debt entries.

## 22. Completion report
(After finishing.) What was delivered vs planned; deviations + why; test evidence summary; performance notes.

## 23. Known limitations
What intentionally doesn't work yet and where that's tracked.

## 24. Technical debt
Debt created, each with: description, impact, suggested payoff phase.

## 25. Next-phase dependencies
What later phases rely on from this one — the interface you've promised them. Then STOP; never auto-start the next phase.
