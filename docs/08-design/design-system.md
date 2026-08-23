# Design System — Tokens, Theme, ui_kit

How the app is styled without a designer, and how the designer restyles it later without a rewrite. Implements system rules 25–27 and ADR-019 (`docs/decisions/`). Built in P2; restyled in P19. Companion docs: `ui-flow-map.md` (screen catalog), `asset-animation-pipeline.md` (assets/animations/audio).

Package: `apps/mobile/packages/ui_kit` — the **only** place style values exist. Screens in `apps/mobile` import components from `ui_kit`; they never import token classes for styling where a component exists, and never contain raw style values at all (rule 25 ⛔).

## 1. Token architecture

Tokens are plain Dart classes in `ui_kit/lib/src/tokens/`, exposed to widgets through a `ThemeExtension`. Two layers:

- **Primitive tokens** — raw palette/scale values (`Palette.grey900`, `Sizes.s16`). Private to `ui_kit`; nothing outside the tokens layer references them.
- **Semantic tokens** — role-named (`color.surface`, `color.danger`, `space.md`). Components consume **only** these. P19 restyles by remapping semantic → primitive; component code is untouched wherever possible.

### 1.1 Token categories

| Category | Class | Contents |
|---|---|---|
| Color | `AppColors` | See role table below |
| Typography | `AppTypography` | Type scale (below), per-style `TextStyle` (family, size, weight, height, letter-spacing). Tabular figures variant for money/timers (`numeric`) |
| Spacing | `AppSpacing` | 4-pt scale: `xxs 2, xs 4, sm 8, md 12, lg 16, xl 24, xxl 32, xxxl 48`. All padding/gaps/insets |
| Radius | `AppRadius` | `sm 4, md 8, lg 12, xl 16, full 999` (pills, chips) |
| Elevation | `AppElevation` | Levels 0–4 as shadow/overlay specs (dark theme: overlay tint > drop shadow) |
| Motion | `AppMotion` | Durations: `instant 0, fast 100ms, base 200ms, slow 300ms, deliberate 500ms, dealCard 250ms, chipMove 400ms, celebration 1200ms`; curves: `standard` (easeInOutCubic), `enter` (decelerate), `exit` (accelerate), `emphasized` (overshoot, celebrations only). Animation wrappers read durations **only** from here (see `asset-animation-pipeline.md §4`) |
| Z-layers | `AppZLayers` | `base 0, tableOverlay 10, actionBar 20, sheet 30, dialog 40, toast 50, offlineBanner 60, forcedUpdate 100` — forced-update/kill-switch surfaces always topmost (rule 17) |

### 1.2 Color roles (semantic)

| Role group | Tokens | Notes |
|---|---|---|
| Ground | `background`, `surface`, `surfaceRaised`, `surfaceSunken` | screen bg, cards, sheets, wells |
| Brand | `primary`, `onPrimary`, `primaryMuted` | placeholder: desaturated blue |
| Status | `success`/`onSuccess`, `danger`/`onDanger`, `warning`, `info` | wins/credits = success, losses/destructive = danger, offline/maintenance = warning |
| Text | `textPrimary`, `textSecondary`, `textTertiary`, `textDisabled`, `textOnAccent` | 4-step hierarchy; contrast ≥ 4.5:1 for primary/secondary |
| Borders | `border`, `borderFocus`, `borderError` | inputs, seat outlines |
| Game | `feltBackground`, `feltLine` | table felt surface + markings (poker table, game boards) |
| Chip tiers | `chipTier1`…`chipTier6` | stake-tier chip colors (1/5/25/100/500/1000-style denominations); `ChipStack` maps denomination → tier token, never hardcodes |

### 1.3 Type scale

`display 32/700 · headline 24/700 · title 18/600 · body 16/400 · bodyStrong 16/600 · label 14/500 · caption 12/400 · numeric 20/600 tabular` (size/weight; heights 1.2–1.5). Placeholder family: system default (Roboto); P19 swaps family + metrics in one place.

### 1.4 Wiring: ThemeExtension

```dart
class AppTheme extends ThemeExtension<AppTheme> {
  final AppColors colors; final AppTypography type; final AppSpacing space;
  final AppRadius radius; final AppElevation elevation; final AppMotion motion;
  // copyWith / lerp per ThemeExtension contract
}
// components:
final t = Theme.of(context).extension<AppTheme>()!;
Container(color: t.colors.surface, padding: EdgeInsets.all(t.space.md), ...)
```

One `ThemeData buildAppTheme(AppTheme tokens)` factory maps tokens onto Material defaults (so bare Material widgets used internally by `ui_kit` also inherit). The app instantiates exactly one theme — no per-screen theme objects.

## 2. Placeholder theme (P2 — implementable spec)

Deliberately plain, functional, unbranded (rule 27). Concretely:

- **Single dark theme.** No light theme until P19 decides whether one exists. `background #121212`, `surface #1E1E1E`, `surfaceRaised #262626`, `surfaceSunken #0D0D0D`.
- `primary #4A7DBD` (muted blue — deliberately not casino-branded), `success #3E8E5A`, `danger #B5484D`, `warning #B58A3E`, `info #4A8E9E`. All desaturated: functional, not attractive.
- Text: `#EDEDED / #B0B0B0 / #7A7A7A / #4D4D4D`; `border #333333`.
- `feltBackground #1B3B2F` (flat dark green, no texture), `feltLine #2A5744`.
- Chip tiers: 6 flat distinguishable hues (`#8A8A8A`, `#B5484D`, `#3E8E5A`, `#404040` w/ light border, `#6A4A9E`, `#B58A3E`) — recognizable casino convention, zero polish.
- Radius `md` everywhere, elevation levels 0–2 only, motion `base`/`standard` only (wrappers still expose the full duration set; placeholder implementations may use simpler values from tokens).
- System font, no images/gradients/textures, no custom icons (Material icons via the asset registry's icon layer where file-based).

Rule of thumb: if a value choice would please a designer, it's out of scope — pick the boring one.

## 3. Theming rules (normative)

1. **Single source:** every style value originates in `ui_kit` token classes. No literals in components, screens, or feature code (`Color(0xFF...)`, `EdgeInsets.all(8)`, `Duration(milliseconds: 300)` all banned outside `tokens/`).
2. **Components use semantic tokens only** — never primitive palette entries, never raw values.
3. **Screens use components, not tokens.** Where a `ui_kit` component exists for a need, screens compose it; screens touching `AppTheme` directly is a smell reviewed as a missing/incomplete component. (Narrow exception: pure layout spacing between components may use `space.*` — nothing else.)
4. Component variants are enum-selected (`AppButtonVariant.danger`), not caller-styled. No `color:`/`textStyle:` style override parameters on `ui_kit` public APIs.
5. New style need → new semantic token or component variant via `ui_kit` PR — never a local value.

## 4. ui_kit component inventory

Catalog for P2 (app-level; game-level components land with P7–P9 but their names/contracts are fixed now). Every component: golden tests per state (ADR-010), entry on the kitchen-sink screen.

### 4.1 App-level

| Component | Purpose | Key states / variants |
|---|---|---|
| `AppButton` | All tap actions | `primary`/`secondary`/`danger`; enabled/disabled/`loading` (spinner replaces label, taps ignored) |
| `AppCard` | Surface container | flat/raised; optional tap |
| `AppDialog` | Confirmations, blocking notices | default/destructive-confirm; barrier per z-layer `dialog` |
| `AppInput` | Text fields | idle/focus/error(+message)/disabled/obscured(password toggle); validation state passed in — no validation logic inside (rule 21) |
| `AppToast` | Transient feedback | info/success/error; queued, z-layer `toast` |
| `EmptyState` | No-content bodies | icon+title+body+optional action |
| `LoadingState` | Full-body loading | spinner/skeleton variants |
| `OfflineBanner` | Connectivity loss (P2 primitive) | offline/reconnecting/resynced-flash; z-layer `offlineBanner` |
| `CountdownTimerRing` | Turn/round timers | running/warning(<25%)/expired; **cosmetic only — server owns timers** (rule 2); driven by server deadline timestamp |
| `BalanceDisplay` | Wallet balance anywhere | Renders **server state only**, minor units + currency code formatted centrally (`TST 1,250`); loading/stale(reconnect) states; no client arithmetic ever (rule 4) |
| `AppBottomSheet` | Secondary flows/pickers | standard/full-height; z-layer `sheet` |
| `AppListTile` | Rows | variants: navigation / value (label+trailing value) / transaction (amount colored success/danger, signed, from server) / setting (switch) |
| `AppTabBar` | Sectioned screens | fixed/scrollable |
| `AppBadge` | Counts & status dots | numeric/dot; info/danger emphasis |

### 4.2 Game-level

| Component | Purpose | Key states |
|---|---|---|
| `TableSeat` | One seat at a table | empty(join affordance)/occupied/self/acting(timer ring)/sitting-out/disconnected(grace indicator) |
| `ChipStack` | Chip amounts as stacks | amount → tier-token colored stack; static/in-motion(via `ChipMoveAnimation`) |
| `PlayingCard` | Single card | face(rank+suit)/back/folded(dimmed); sizes sm/md/lg |
| `PotDisplay` | Pot(s) incl. side pots | main/side-pot list; updating |
| `ActionBar` | Player bet controls | contextual actions (fold/check/call/bet/raise…), enabled set + bet slider/stepper bounds all **from server state**; disabled-when-not-acting |
| `StakeSelector` | Stake tier / buy-in choice | tier list w/ min-max; insufficient-balance state |
| `MultiplierCurve` | Crash-class round display (OQ-05) | idle/rising/crashed; renders server-fed curve points only |
| `RoundHistoryStrip` | Recent round results | scrolling chips of past results |
| `WinCelebration` | Win moment wrapper | intent-named animation wrapper — see `asset-animation-pipeline.md §4` |
| `CardDealAnimation` | Deal motion wrapper | idem |
| `ChipMoveAnimation` | Chips-to-pot/winner wrapper | idem |

## 5. Component API conventions

- **State in, events out.** Constructor takes immutable display state (freezed models from Riverpod layer) + callbacks (`onPressed`, `onAction(GameAction)`). No component owns business state.
- **No business logic, no network.** Components never import `api_client`, Riverpod providers, or domain logic. Validation display only — rules live server-side (rules 1, 21).
- Money is always passed as minor-unit `int` + currency code and formatted by one shared formatter inside `ui_kit`; components never do money math beyond formatting.
- Timers: components receive server deadlines/durations, render countdown cosmetically; expiry actions are server events, not client callbacks.
- Naming: `App*` app-level; game components domain-named; animation wrappers intent-named (rule 26).
- Every component exports a `// states:` doc header enumerating its states — mirrored by golden tests and the kitchen sink.

## 6. Kitchen-sink dev screen (required, P2)

A dev-flavor-only screen (route `/dev/kitchen-sink`, excluded from staging/prod route config) rendering **every** `ui_kit` component in **every** documented state, grouped by section, built exclusively from tokens/components. Purposes: P2 acceptance evidence (roadmap P2), golden-test source of truth, and the designer's live catalog in P19. A component merged without a kitchen-sink entry fails review.

## 7. Restyle contract (P19)

What P19 is allowed to touch — and the measurable acceptance that it touched nothing else:

- **Designer changes:** token values (`tokens/`), theme composition, component internals (visual structure inside `ui_kit`), real assets in `packages/assets` (same registry names — `asset-animation-pipeline.md §5`), animation wrapper internals (Rive/Lottie), route ordering/transitions in the central go_router config.
- **Screens untouched.** No screen-, provider-, or api_client-layer diffs for restyle purposes. If a restyle genuinely needs logic change, that is a phase-plan amendment (MASTER_ROADMAP P19), not a quiet edit.
- **Acceptance (diff-audited):** the P19 diff is confined to `apps/mobile/packages/ui_kit/`, `apps/mobile/packages/assets/`, and the router-config file(s). CI aids the audit with a path-filter report on the P19 branch; reviewer signs off that any file outside those paths is an approved amendment.

## 8. Enforcement — "no hardcoded styles"

Layered, per P0 lint baseline + P2 wiring:

1. **Custom lint rules** (`custom_lint` package in the workspace, dev-only): outside `ui_kit/lib/src/tokens/`, forbid `Color(`/`Colors.` constructors, numeric `EdgeInsets`/`SizedBox`/`BorderRadius` literals, `Duration(` in widget code, `TextStyle(` with explicit size/color, and raw asset-path strings (see `asset-animation-pipeline.md §2`). Inside `ui_kit` components, additionally forbid primitive-token imports.
2. **Import boundaries:** lint forbids `apps/mobile` screens importing `ui_kit/src/tokens/**` (public exports expose components + `AppTheme` accessor only) and forbids `ui_kit` importing `api_client`/app code.
3. **Review checklist:** PR template item — "no raw style values; new needs became tokens/variants" — the backstop while custom rules mature (P0 ships the placeholder rule set; gaps are checklist-enforced, per roadmap P2 acceptance).
4. **Golden tests** catch accidental restyles of placeholder components; in P19 goldens are regenerated once, deliberately, in the ui_kit-only diff.

Escape hatch: none for screens. A justified exception inside `ui_kit` uses `// ignore: <rule> -- reason` and is called out in review.
