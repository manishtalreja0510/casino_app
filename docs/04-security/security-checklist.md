# Security Checklist (per-phase gate)

The literal gate for every phase (rule 28: the checklist runs before a phase completes; rule 18: unchecked items = phase not done). **Phase plans must copy the relevant sections below into their plan's §15** and check them with evidence links (test names, CI runs, audit entries) — "checked" means *demonstrated*, not *believed*. Sections B–D apply when the phase touches that surface; section A always applies; section E applies to release/launch gates (P13 releases, P14, P18).

Companion docs: `./threat-model.md` (what we're defending), and the per-topic docs referenced inline.

## A. Every phase

- [ ] **Authz deny-by-default** — every new REST endpoint and WS event has an explicit guard (auth, account-state, role); a request with no/wrong principal is rejected. Pass: authz test per new endpoint/event, including the negative case.
- [ ] **Input validation from contracts** — all new inputs validated against `packages/contracts` schemas server-side (client validation is UX only, rule 21). Pass: malformed-input tests reject with the standard error envelope.
- [ ] **Rate limits considered** — each new endpoint/event assigned to a rate class (`./network-security.md §5`), or an explicit "read-class default" note. Pass: class recorded in the phase plan; limit test for any new sensitive class.
- [ ] **Audit events for sensitive actions** — any new money/auth/admin/void/flag action writes to the hash-chained audit log (rule 15). Pass: audit-completeness test enumerating the phase's sensitive actions.
- [ ] **No PII/secrets in logs** — new log statements use opaque IDs only. Pass: log-scrubber tests cover new fields; grep of new code for email/name/token/document fields in log calls comes back clean (evidence: grep output or lint rule reference).
- [ ] **No new secrets outside the secret manager** — any new credential is in the inventory (`./secrets-management.md §2`) with owner/rotation/blast-radius. Pass: inventory diff in the phase PR; gitleaks green.
- [ ] **Error responses leak no internals** — no stack traces, SQL, paths, or dependency versions in any new error path. Pass: error-shape tests on new failure modes.
- [ ] **Dependencies scanned** — new/updated packages pass vulnerability scan; no unaddressed criticals/highs. Pass: CI scan green or documented, time-boxed exceptions.
- [ ] **Threat-model delta reviewed** — new endpoints/tables/flows mapped to `./threat-model.md` boundaries; new threats added there in this PR (`./threat-model.md §5`). Pass: delta note (possibly "no new surface") in the phase plan.
- [ ] **All of the above tested and green** — the phase's security tests run in CI and pass (rule 18). Pass: CI link.

## B. Financial-touching phases (P4, P6, P8, P9, P12, P17, P18 — and any phase moving value)

- [ ] **Idempotency tests** — every new mutating financial endpoint replays as a no-op returning the original result; key-collision-with-different-payload rejected (`./financial-security.md §3`).
- [ ] **Concurrency/race tests** — parallel-spend storm cannot overdraw; ordered-lock discipline followed (lock-order noted in code review); crash mid-tx leaves ledger consistent (`./financial-security.md §4`).
- [ ] **Ledger invariant tests** — sum-zero per transaction, append-only enforcement (UPDATE/DELETE rejected at DB level), non-negative user balances, currency-match per entry (`./financial-security.md §1, §12`).
- [ ] **Reconciliation coverage** — new money flows are covered by a reconciliation check; injected fault is detected in staging and pages (`./financial-security.md §10`).
- [ ] **Four-eyes where required** — new adjustment/gate paths enforce initiator ≠ approver with both audited (`./financial-security.md §9`).
- [ ] **Rounding rules explicit** — any new percentage-derived amount documents its integer rounding rule (house's disfavor default) with a property test (`./financial-security.md §11`).

## C. Game-touching phases (P6, P8, P9, and every future game)

- [ ] **Conformance suite green** — the game passes the full P6 contract conformance suite in CI (`../02-domains/game-engine.md §13`).
- [ ] **Information-hiding tests incl. resync** — adversarial protocol tests request other players' state, replay/forge resume, join rooms uninvited: zero hidden bytes leak on any path including reconnect/resync (`./game-security.md §5`).
- [ ] **RNG draws audited** — every outcome traces to a logged draw (id, match, purpose, commitment); conformance test proves no unlogged randomness (`./game-security.md §2`).
- [ ] **Timers server-side** — all game clocks/timeouts run on the server timer framework; client timers cosmetic only (rule 2). Pass: timeout tests with a non-cooperating client.
- [ ] **Kill-switch drain tested** — per-game switch blocks new matches, drains or voids+refunds in-flight ones with escrow zeroed (`./game-security.md §11`).
- [ ] **Timing/shape review** — new responses that could branch on hidden info reviewed for constant shape (`./game-security.md §6`).

## D. Client-touching phases (P2, P3, P7–P9, P11, P13, P19 — any phase shipping app code)

- [ ] **No hardcoded styles** — rule 25 lint/review check passes, or explicit N/A note for non-UI client changes.
- [ ] **No secrets in binary** — string-dump check on the release APK against secret patterns is clean; dart-defines contain only public config (`./secrets-management.md §4`).
- [ ] **Obfuscation on release** — `--obfuscate --split-debug-info` active on staging+prod builds; mapping files archived to the restricted store (`./mobile-app-hardening.md §1`).
- [ ] **Hardening signals wired** — new screens/flows emit the applicable signals (or N/A note); sensitive new screens set `FLAG_SECURE` per policy (`./mobile-app-hardening.md §4, §6`).
- [ ] **Client validates for UX only** — every new client-side check has a server-side counterpart test (rule 21).

## E. Release / launch gates (each P13 release; P14 exit; P18 go-live)

- [ ] **Pen-test findings closed** — all critical/high findings remediated and retested; mediums triaged with owners/dates (P14, re-verified P18).
- [ ] **Load targets met** — P14 load/chaos targets green with error budgets on the current config (re-run on final config at P18).
- [ ] **Runbooks current** — incident, rotation, key-custody, freeze, and kill-switch runbooks reviewed this phase and drilled since last gate (`../07-operations/runbooks.md`).
- [ ] **Forced-update path tested** — old build → prompt → install e2e green; below-min-version build blocked from authenticated endpoints; tampered manifest/APK rejected (rule 17, `./threat-model.md` TB4).
- [ ] **Pins valid + backup pinned** — serving key is in the fleet's pin-set; at least one undeployed backup pin shipped; staging rotation drill done since last key event (`./network-security.md §3`).
- [ ] **Key custody verified** — offline keys (prod APK, pinning-update) confirmed per custody procedure; CI holds no prod-identity keys; admin bootstrap credentials destroyed (`./secrets-management.md §7`).
- [ ] **Secrets posture clean** — gitleaks + history scan green; inventory reviewed; no expired-rotation items (`./secrets-management.md §2, §6`).
- [ ] **Kill-switches drilled** — global, per-game, and real-money gate exercised in staging this cycle (rule 16).
- [ ] **(P18 only) Compliance gates** — license live, RNG certification issued for shipped games (ADR-016), geo-fencing enforced, `compliance.real_money_enabled` flipped via four-eyes only after every other box above is checked.

---

**Process notes.** A checklist item that cannot be met gets an explicit, dated exception approved by the phase owner and recorded in the phase plan — silence is failure (rule 18). Items here evolve: changes to this file go through PR review like any doc, and `./threat-model.md §5` cadence keeps sections A–E aligned with new threats.
