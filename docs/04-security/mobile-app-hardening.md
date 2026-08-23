# Mobile App Hardening

**Framing first, and it is normative (rules 1–3):** every control in this doc runs on hardware the attacker owns. All of it is bypassable by definition — a skilled attacker patches out any check we ship. These controls therefore exist to (a) **raise attacker cost and skill floor**, and (b) **generate risk signals** the server weighs (`../02-domains/fraud-risk.md`). They are **never gates**: no client-side check hard-blocks play or money by itself; the action ladder is degrade/flag/review, decided server-side. We never claim any of this "prevents reverse engineering."

Phases: signal wiring lands in P10; build flags in P2; self-check and channel posture tie into P13. Threat rows: `./threat-model.md` TB1 (modified client, instrumentation, emulator farms) and TB4 (modded redistribution).

## 1. Build-time obfuscation

`flutter build --obfuscate --split-debug-info=<dir>` on **every release build** (staging + prod), wired in P2 CI.

| Does | Does not |
|---|---|
| Obfuscates **Dart AOT symbols** (class/method/library names) — stack traces and disassembly lose meaningful names | Encrypt or hide **string literals**, assets, or resources — `strings` on the binary still yields endpoints, event names, any embedded text |
| Raises effort to map decompiled code to features | Protect native (NDK/plugin) symbols, Java/Kotlin shell code (R8/proguard handles that layer, also enabled), or control flow |
| Keeps crash symbolication possible via mapping files | Stop dynamic analysis at all — Frida sees live objects regardless of names |

**Mapping-file custody:** `--split-debug-info` output + R8 mapping per release are build artifacts required for crash symbolication (Sentry, OQ-10). They **deobfuscate the binary**, so treat as sensitive: stored in CI artifact storage/symbol server with restricted access, never in the repo, never shipped; retention matched to supported-version window. Custody listed in `./secrets-management.md §2` (sensitive-artifact class, not a secret proper).

## 2. Environment detection signals

All detections below are best-effort, evadable, and reported — not enforced — client-side.

| Signal | Checks (indicative, not exhaustive) | Meaning server-side |
|---|---|---|
| Root | `su` binaries on PATH, Magisk artifacts (paths, packages, mount anomalies), writable system partitions, known root-manager packages | elevated risk weight; common among enthusiasts → weight, don't panic |
| Emulator | build fingerprints (generic/goldfish/ranchu), QEMU device files, sensor absence/constancy, telephony absence | strong multi-accounting/farm signal, especially many-accounts-per-fingerprint |
| Hook/instrumentation | Frida server artifacts (default ports, named pipes, `frida-agent` in `/proc/self/maps`), Xposed/LSPosed presence, suspicious loaded libs, unexpected open ports | high-weight signal; correlates with probing/botting |
| Debugger / dev flags | `Debug.isDebuggerConnected`, ADB/USB-debugging enabled, developer options | weak alone; combines |

Detection code is itself patchable — expected. The *absence* of signals from a client that behaves anomalously is itself informative to the risk engine (signal tampering is a hypothesis the server can hold; we don't pretend to detect it reliably).

## 3. APK signature self-check

At startup (and opportunistically), the app checks its own signing certificate digest against the expected value and reports the result. **Detects:** re-signed modified APKs (any modification forces re-signing — attacker can't have ours, `./secrets-management.md §7`). **Trivially patchable:** the mod removes the check or hardcodes the pass result. **Still worth shipping:** it filters the low-effort tier of mods, and every modded client that *doesn't* patch it identifies itself — cheap signal, honest expectations. Failed/absent self-check reports feed the risk engine and the P13 channel-monitoring picture (`./threat-model.md` TB4).

## 4. Screen-capture policy

`FLAG_SECURE` on sensitive screens: anything showing hole cards, balances during play, KYC capture, recovery flows. Blocks casual screenshots/screen-recording and hides content in app-switcher thumbnails. Bypassable on rooted devices (everything is); the poker value is real though modest — it stops the *easiest* hole-card sharing path (screen-share collusion still possible via second camera; that's the collusion heuristics' problem, `./game-security.md §8`).

## 5. Play Integrity API (OQ-12) — honest evaluation

- Works for **sideloaded apps on devices with Play services** (most of the fleet): request an integrity verdict, verify **server-side** via Google's API.
- **App-identity verdict will report an unrecognized install source** — we are off-Play by design. That field is **ignored, never trusted, never a penalty**. We use **device-integrity verdicts only** (`MEETS_DEVICE_INTEGRITY` etc.).
- **Unavailable on de-Googled devices** (no Play services) — absence of a verdict is *not* guilt; the fallback is simply the rest of the signal set (§2–3) with appropriate weights.
- Verdict requests are server-nonce'd (bind verdict to session, prevent replay/proxying of a clean device's verdict — raises cost, not airtight).
- Per OQ-12: **one weighted risk signal, never a gate.**

## 6. Signal reporting protocol

- Signals are **batched** client-side and sent on an authenticated, **signed** endpoint (piggybacks the device-binding machinery, `./authentication-security.md §4`); server timestamps on receipt (client clocks untrusted).
- Payload: signal type, value, app version, coarse device model — **no PII**, no raw filesystem paths beyond the matched-artifact class.
- **All weighing is server-side** in the risk engine: per-signal weights, combinations, per-population baselines. Client ships facts, never verdicts.
- **Response posture: degrade/flag, not hard-block.** Typical ladder: log-only → tighten limits/velocity → require step-up (e.g. re-auth for withdrawals) → manual review → freeze (server decision on accumulated evidence, appealable via support). A false-positive hard block on an honest rooted-phone user costs more than a monitored bot session costs us on test currency.
- A client that never reports (patched-out reporter) on an account whose behavior warrants signals is itself a server-side observable (version/behavior mismatch heuristics).

## 7. Local data anti-tamper

- Cached/local data (session material, preferences, queued events) encrypted with **Keystore-backed keys** (`./authentication-security.md §2` for token specifics).
- **Nothing secret lives client-side anyway** (rule 1 + rule 14): no game logic worth stealing, no balances that matter (server truth), no API secrets (dart-defines are public, `./secrets-management.md §4`). Local tamper therefore mostly self-harms; the encryption raises the bar for casual on-device snooping and backup scraping, no more.

## 8. What we explicitly do NOT rely on

- **Packers / commercial RASP / code virtualization:** not at launch. Cost, SDK bloat, crash-diagnostics interference, and vendor claims that overpromise. **Re-evaluate only if observed attacker pressure warrants** (documented trigger: sustained modded-client or botting campaigns that server-side controls contain but expensively) — that re-evaluation is an ADR.
- **Security through obscurity claims:** none. Obfuscation and detection are cost/signal measures; the protocol, endpoints, and client behavior are assumed fully known to attackers.
- **Client checks as authorization:** never. Every outcome, balance, timer, and hidden-info decision is server-side regardless of any signal state.

## 9. Testing the hardening

Each signal ships with a **test rig** proving it fires and reports:

| Rig | Approach |
|---|---|
| Root/Magisk | rooted emulator image + Magisk in CI-adjacent device lab; assert signal emitted + received server-side |
| Emulator | stock AVD run asserts emulator signal; real-device run asserts absence |
| Frida | test harness attaches frida-server, asserts detection report; also documents current bypass (keeps us honest about efficacy) |
| Self-check | re-sign the APK with a test key, assert failure report path |
| Play Integrity | staging project verdicts on clean + emulator devices; absence path on emulator without Play |
| Reporting | contract tests on the batch endpoint; server weighing unit-tested in risk engine (P10) |

False-positive review is part of P10 acceptance: baseline signal rates on honest staging devices are recorded before weights go live.
