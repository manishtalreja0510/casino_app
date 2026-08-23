# Asset & Animation Pipeline

How assets, animations, audio, and haptics are referenced, named, placeholdered, and later replaced by real design work — so P19 is a file-drop plus wrapper-internal swaps, never a call-site hunt. Implements system rule 26 and ADR-019. Companions: `design-system.md` (motion tokens, wrapper components), `ui-flow-map.md`.

Package: `apps/mobile/packages/assets` — placeholder asset files + the generated registry. Nothing outside this package holds an asset path.

## 1. Generated asset registry

- **Tool:** `flutter_gen`-style class codegen over the package's asset tree (run via melos script, same codegen pass as freezed/riverpod). Output: typed accessors, e.g. `Assets.images.poker.imgTableFelt`, `Assets.audio.chips.sfxChipStack`.
- **No raw asset-path strings anywhere** — lint-enforced (string literals matching `assets/` or known extensions banned outside the generated file; same custom-lint layer as `design-system.md §8`).
- **Missing asset = build error:** a reference to a removed/renamed asset fails codegen/compile, not runtime. Registry regen is a CI check (generated file up to date with the tree, or the build fails).
- `ui_kit` components and animation wrappers consume registry accessors; screens generally shouldn't need direct asset references at all (components own their imagery).

## 2. Naming conventions — FINAL now

Names are the P19 contract: real assets **replace files under identical names**. Chosen in planning precisely so they never churn.

**Structure:** `assets/{images|icons|animations|audio}/{domain}/{name}_{variant}@{dpi}.{ext}`

Rules:
1. **Casing:** paths and filenames `lower_snake_case` only. Codegen produces the camelCase Dart names.
2. **Type prefixes** (the `name` part): `img_` raster/vector images, `ic_` icons, `anim_` animation files (Rive/Lottie later; placeholder formats now), `sfx_` sound effects, `mus_` music/loops.
3. **Domain folders:** `common`, `brand`, `poker`, `casino_game_1` (renamed once OQ-05 closes — a folder rename + regen, done before P8 starts), `wallet`, `lobby`, `onboarding`, `celebration`. New domain folders require a PR touching this doc.
4. **Variant suffix** (optional): state/denomination/size discriminators — `_pressed`, `_disabled`, `_100` (chip denom), `_back`.
5. **DPI variants:** raster images ship `@1x` (bare), plus Flutter-conventional `2.0x/`, `3.0x/` subfolders. Vector (SVG-as-compiled), Rive, Lottie, audio: single file, no dpi variants.
6. **Extensions:** images `webp` preferred (`png` where alpha fidelity demands), icons `svg` (via vector-graphics compilation) or `webp`, animations `riv`/`json` (Lottie), audio `ogg`.

Examples (canonical):
```
assets/images/poker/img_table_felt.webp        → Assets.images.poker.imgTableFelt
assets/icons/wallet/ic_chip_100.svg            → Assets.icons.wallet.icChip100
assets/animations/poker/anim_card_deal.riv     → Assets.animations.poker.animCardDeal
assets/audio/common/sfx_chip_stack.ogg         → Assets.audio.common.sfxChipStack
assets/images/celebration/img_confetti_burst.webp
assets/audio/casino_game_1/sfx_round_start.ogg
```

## 3. Placeholder policy (from P2)

- **Every referenced asset exists** from the moment it is referenced — as a deliberately plain placeholder (flat-color webp, minimal svg, silent ogg, trivial animation file). No "TODO asset" branches, no null-image fallbacks in components.
- Referencing a new asset = adding its placeholder file + regen in the same PR. Because the registry is generated, a missing file is a build error, so this is self-enforcing.
- Placeholders follow rule 27: functional, unbranded, ugly-on-purpose (e.g. `img_table_felt` = flat `feltBackground`-colored rectangle). No sourced/purchased art before P19.
- Placeholder audio files are valid-but-silent (or near-silent ticks in dev flavor for verifying trigger points).

## 4. Animation wrapper pattern

All non-trivial motion goes through **intent-named wrapper widgets** in `ui_kit` (rule 26): `CardDealAnimation`, `WinCelebration`, `ChipMoveAnimation`, `RoundCountdown` (list grows per game phase; each addition is registered in `design-system.md §4.2`).

**Public API = intent + callbacks. Nothing else.**

```dart
class CardDealAnimation extends StatelessWidget {
  const CardDealAnimation({
    required this.card,          // display state in (PlayingCard model)
    required this.dealt,         // is the deal complete (idempotent state, not an imperative "play()")
    this.onDealComplete,         // completion callback
    this.delayIndex = 0,         // stagger position for multi-card deals
  });
}
```

API design rules that make the P19 swap zero-call-site:
1. **No implementation leakage:** no `AnimationController`, Rive controller, artboard/state-machine names, or Lottie composition types in any public signature. Internals are private to the wrapper.
2. **Declarative trigger:** callers pass target state (dealt/celebrating/moving-to), not imperative play commands; the wrapper animates the transition. Replays/interruptions are wrapper concerns.
3. **Durations & curves only from `AppMotion` tokens** (`design-system.md §1.1`) — P19 retunes motion globally by editing tokens.
4. **Completion callbacks** (`onDealComplete`, `onCelebrationEnd`) are the only sequencing surface; game logic never times animations itself — and animations are always cosmetic: server events drive state regardless of whether an animation finished (rule 2).
5. **Reduced-motion aware:** wrappers honor the OS reduce-motion setting internally (skip-to-end + still fire callbacks); callers do nothing.

**Placeholder implementation (P2–P9):** built-in Flutter implicit/explicit animations (`AnimatedPositioned`, `TweenAnimationBuilder`, explicit controllers privately) — crude but real, proving triggers/sequencing/callbacks. **P19:** internals swap to Rive or Lottie per animation; call sites, tests of sequencing, and screen code unchanged.

## 5. Rive vs Lottie (evaluation summary — decision deferred to P19)

| | Rive | Lottie |
|---|---|---|
| Strengths | State machines, runtime inputs, interactivity; small runtime + compact `.riv` files | After Effects pipeline — broad designer familiarity; huge existing ecosystem |
| Fit here | **Game pieces**: card deal/flip, chip movement, seat states, countdowns — anything state-driven or interactive | **One-shot cinematics**: win celebrations, onboarding flourishes, empty-state art |
| Costs | Designers may need Rive editor onboarding | No state machines; parameterization is limited; JSON can be heavy |

Working assumption: Rive for game-loop pieces, Lottie for celebrations/onboarding — but **the decision is made per-animation with the designer in P19**, and the wrapper pattern (§4) makes it swappable per-animation with zero call-site changes. Both runtimes are permitted dependencies of `ui_kit` internals only. Not an OQ: nothing outside P19 depends on the choice.

## 6. Audio & haptics

- Audio files live in the same registry (`sfx_`/`mus_`, §2). Playback only via a `SoundService` abstraction (Riverpod-provided, `ui_kit`-adjacent); haptics via `HapticService`. No direct `just_audio`/`HapticFeedback` calls in screens or components — services are the swap/upgrade point.
- Intent-level API: `sound.play(Sfx.chipStack)`, `haptic.impact(HapticLevel.medium)` — intensity/level scales defined as tokens alongside `AppMotion`.
- **Placeholders:** silent audio files (§3) + no-op-by-default haptic mapping; the trigger wiring is built and testable long before real sound design (P19).
- **Settings & RG/accessibility:** user mute toggles for sound and haptics in Settings (`ui-flow-map.md`, Account flow) respected by the services centrally; reality-check and RG notices (`docs/02-domains/responsible-gaming.md`) are never audio-only and ignore mute for their visual channel. Reduce-motion/mute never break gameplay — all cues have visual equivalents.

## 7. Designer handoff pipeline (P19)

1. **Asset drop-in:** designer (or integrating dev) replaces placeholder files **keeping exact names/paths** (§2) incl. dpi variants → regen → app is re-skinned with zero code changes for pure asset swaps.
2. **New assets:** added under the conventions + registry regen + placeholder-to-real review; new names appear only via PR (they extend the contract).
3. **Animation integration:** `.riv`/`.json` files land in `assets/animations/`; wrapper internals swap per §4; sequencing tests unchanged.
4. **Review checklist per asset PR:** naming/casing/domain correct; dpi variants present for raster; file sizes within budget (§8); formats per §2; licensing recorded for purchased assets (source, license type, proof archived in the private asset-license register — no unlicensed art ships); no asset embeds text needing localization; celebration/urgency assets reviewed against RG tone constraints (no loss-disguised-as-win flourishes).

## 8. Performance budget notes

Targets tuned in P14/P19 phase plans; planning baselines:

- **Texture memory (low-end Android is the floor device):** total decoded-image budget per screen ≤ ~64 MB on a 2 GB-RAM device; prefer `webp`, right-sized dpi variants (no 3.0x-only assets scaled down), `cacheWidth/Height` where components render small.
- **Jank budget:** game screens hold 60 fps; animation frame budget ≤ 8 ms UI-thread (headroom for WS event handling). Rive preferred over heavy Lottie JSON in the game loop partly for this. Celebrations must degrade (particle counts) rather than drop gameplay frames.
- **Pre-cache strategy:** entering a game route pre-caches that game's asset domain (images via `precacheImage`, animation files loaded/warmed, first-frame Rive artboards instantiated) during the matchmaking/seating screens — loading happens in waits, never mid-hand. Common assets pre-cached post-splash.
- **Audio latency:** SFX pre-loaded into the player pool on game entry; cold-start audio in a live hand is a bug.
- Budgets are asserted where cheap (asset-size CI check per file class: e.g. images ≤ 300 KB, Lottie ≤ 150 KB, audio ≤ 200 KB — exceptions require review) and measured in P14 profiling runs.
