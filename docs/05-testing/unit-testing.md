# Unit Testing Conventions

Fastest, densest layer of the strategy ([testing-strategy.md](./testing-strategy.md)). Unit = no I/O, no containers, no network, no real time. Everything here runs on every commit and must stay fast (§5).

## 1. Backend (Jest)

- **Scope**: one module's domain logic at a time, respecting module boundaries (system-rules 20). Domain services are written pure where possible — inputs in, results/instructions out — precisely so they are unit-testable without infrastructure.
- **Ports injected, never ambient**: RNG (`RngService`), clock, and ID generation (UUIDv7) reach domain code only through injected ports. Unit tests supply a seeded RNG, a fake clock, and a deterministic ID sequence. Code reading `Date.now()`, `Math.random()`, or `crypto` directly in domain logic fails review.
- **No DB mocks pretending to be the DB**: logic that fundamentally depends on locking/constraints is tested at integration level against real PG ([integration-testing.md](./integration-testing.md)); unit tests cover the pure computation extracted from it. Don't unit-test a mocked repository's behavior.
- **Mocking discipline**: mock only ports at module boundaries (other modules' exported services, external ports). Never mock the class under test's internals.

### Property-based testing (fast-check) — REQUIRED for:

| Target | Properties (examples, not exhaustive) |
|---|---|
| Ledger operations | entries per transaction sum to zero for any op sequence; replay of same idempotency key is a no-op; reversal of any transaction restores derived balances; user balances never negative for any interleaving the domain permits |
| Side-pot algorithm (poker) | sum of pots == sum of committed chips; no player eligible for a pot beyond their contribution level; pot distribution deterministic for permuted input order |
| Hand evaluator | agreement with known-vector corpus (published evaluator test vectors); ranking transitivity and antisymmetry over generated hands; 5-of-7 selection optimality |
| Settlement math | settlement instructions sum to escrow exactly; winners+rake == escrow (escrow zeroes out); idempotent by match id |
| Rake rounding | rake per configured schedule, integer minor units only, rounding rule fixed (defined in poker phase plan) and total conserved — no minor unit created or destroyed |

Property runs: default iteration count on PR, elevated count nightly; failing seeds printed and committed as regression cases.

### Also unit-tested here
Reducers of every game (seeded RNG ⇒ deterministic `reduce`/`onTimeout` outputs), risk rule evaluation, token/session state machines (pure parts), config schema validation, error-code mapping.

## 2. Flutter (flutter_test)

- **Provider/logic tests without widgets**: Riverpod providers and freezed-model logic tested headlessly (ProviderContainer-level) — reducers of client state, resume/reconnect state machines, error-presentation mapping.
- **Widget tests for `ui_kit` components** only — Button, Card, Dialog, Input, TableSeat, ChipStack, TimerRing, Toast, EmptyState, …: behavior (tap/disabled/loading states) + **golden tests per token theme** (currently the single placeholder dark theme; P19 adds approved theme(s) — goldens re-baselined then, per theme). Goldens run on a pinned Flutter version/renderer in CI to avoid rasterization drift.
- **Screens have no logic to unit-test — by architecture** (system-rules 21, 25): screens are thin render-state/fire-events shells. If a screen needs a unit test, the logic is in the wrong layer; move it to the Riverpod layer. Screen coverage happens at integration/e2e level.
- No network/plugins in unit scope; API client behavior is covered by contract tests ([integration-testing.md §8](./integration-testing.md)).

## 3. Naming & layout

- Backend: tests co-located per module, `*.spec.ts` (unit) vs `*.int-spec.ts` (integration, separate Jest project). Describe blocks name the invariant, not the method: `"escrow zeroes out at settlement"`, not `"settle() works"`.
- Flutter: `test/` mirrors `lib/`; `*_test.dart`; goldens under `test/goldens/<theme>/`.
- One behavior per test; factories from the shared factory package for all entities (no inline hand-built fixtures for domain objects); no test depends on another's side effects.

## 4. Required unit-test classes per domain

Minimum bar per domain — phase plans may add, never remove:

| Domain | Must-have unit-test classes |
|---|---|
| wallet | ledger op properties (above); balance-derivation math; idempotency-key semantics; reversal construction |
| game-engine | lifecycle transitions (legal/illegal); snapshot+replay equivalence (pure part); settlement-instruction application mapping; RNG draw accounting |
| games/poker | hand evaluator vs vectors; side pots; betting-round legality (min-raise, all-in, action order); rake rounding; blind posting; `playerView` field filtering (pure check) |
| games/casino-game-1 | payout table exactness vs seeded RNG stream; round state machine; config schema bounds |
| matchmaking | queue-eligibility rules; stake-tier matching logic (pure part) |
| auth | token lifetime/rotation state machine; signature canonicalization (method\|path\|body-hash\|timestamp\|nonce); lockout counters |
| payments | deposit/withdrawal state-machine transitions (all edges, incl. failure/chargeback states); webhook event → transition mapping |
| risk | rule evaluation; score aggregation; action selection (allow/flag/limit/review/freeze) precedence |
| responsible-gaming | limit arithmetic (deposit/loss/session windows); self-exclusion/cool-off state machine; reality-check scheduling logic |
| realtime | seq/envelope ordering logic; resume-decision logic (replay vs resync, pure part) |
| audit | hash-chain computation; event canonicalization |
| platform | flag resolution incl. fail-closed behavior; kill-switch precedence |
| ui_kit (Flutter) | widget + golden per component per theme |
| mobile logic | auth/session providers; reconnect state machine; wallet display formatting (integer minor units → display, no float math) |

## 5. Speed budget

Whole backend unit suite: **< 3 minutes** on CI; Flutter unit+widget (excl. goldens) similar. A single test > 1s is suspect (hidden I/O or unfaked time). Budget breaches are treated like flakes: issue filed, owner assigned ([testing-strategy.md §9](./testing-strategy.md)). Property-test iteration counts are the tuning knob — reduce on PR, never below a floor set in the phase plan; run high nightly.
