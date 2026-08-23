## What and why

<!-- What changed, and which phase / issue it belongs to. Link the phase plan. -->

Phase: `P__` — `docs/phases/PHASE-__-____.md`

## Checklist

- [ ] Scope matches the approved phase plan (no silent expansion — rule 28)
- [ ] Tests added/updated; full suite green with **no skips** (rule 18)
- [ ] Lint, typecheck and build clean
- [ ] `docs/04-security/security-checklist.md` items for this change are closed (mandatory for any sensitive change — rule 28)
- [ ] No secrets in code, config, or fixtures; only `.example` templates committed (rule 14)
- [ ] No PII or secrets in logs (rule 15)
- [ ] Money handled as integer minor units through the ledger only, if touched (rules 4–6, 10)
- [ ] Affected docs, `docs/progress.md`, and `docs/08-design/ui-flow-map.md` (if UI changed) updated in this PR (rule 29)
- [ ] Architectural change? An ADR is included (rule 19)

## Security notes

<!-- Threats introduced or touched, authz for new endpoints/events, audit events emitted. "None" requires a reason. -->
