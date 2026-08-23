# Distribution & Updates (Off-Store Channel)

Ops doc for the off-store Android channel (ADR-017, built **P13**). The updater is the **only security-patch channel** for an off-store app — rule 17: forced update must always work; no change may break the version-check/update path of shipped clients. Build pipeline: `ci-cd.md` §5. Key custody: `runbooks.md` d.

## 1. Hosting layout

Own domain (e.g. `get.<domain>`), HTTPS only, behind the same WAF/CDN class as the API; per-environment hosts (dev/stg/prod — `environments-and-flavors.md`).

```
/releases/<flavor>/app-<versionName>-<versionCode>.apk      immutable, versioned forever
/releases/<flavor>/app-<...>.apk.sha256
/<flavor>/latest.json                                       signed manifest (below)
/download                                                    human download page (§8)
```

**Signed manifest** (`latest.json` class), one per flavor:

| Field | Meaning |
|---|---|
| `version` / `versionCode` | latest release |
| `minSupported` | forced-update floor (§4) |
| `url` | APK URL (versioned, immutable) |
| `sha256` | APK digest |
| `releaseNotes` | player-safe notes |
| `rollout` | staged rollout % (§5) |
| `signature` | detached signature over the canonicalized manifest, made with the **offline manifest key**; client verifies against its pinned public key (`MANIFEST_PUBKEY` build config) before trusting any field |

Manifest key ≠ APK signing key; both offline-custody (runbook d). Manifest key rotation supported from day one via signed key-rotation message (see `backup-disaster-recovery.md` §6 — key-loss mitigation).

## 2. In-app updater flow

1. **Check:** on launch + resume (throttled) call the version-check endpoint / fetch manifest; server may also nudge via notification (P11) for important releases.
2. **Rollout gate:** deterministic bucket (hash of installId) vs `rollout` %.
3. **Download** APK over HTTPS to app-private storage.
4. **Verify:** sha256 matches manifest **and** manifest signature valid against pinned key — both required before any install prompt. Failure ⇒ discard + risk-signal report (channel tamper indicator), never prompt.
5. **Install:** hand to Android installer (user-driven; `REQUEST_INSTALL_PACKAGES`). **The OS independently verifies the APK signature** — an update not signed by our prod key won't install over the existing app. Our checks protect the channel; Android protects the install.

Updater code path is deliberately boring and maximally stable: no feature flags, no experiments, minimal dependencies; changes to it get the heaviest review + the update-path e2e in every release (`ci-cd.md` §5).

## 3. Anti-tamper posture

Honest framing (rule: raises attacker cost, never "prevents"):

| Measure | Effect |
|---|---|
| Signed manifest + pinned verify key | re-hosted/tampered manifest or APK-swap on a mirror can't drive our updater |
| Android signature enforcement | modified APK can't install *over* the genuine app |
| Client signature self-check → risk signal | re-signed clones report (until patched out) — weighted signal to risk engine, never a gate (`../02-domains/fraud-risk.md`, OQ-12) |
| Server-side behavioral/attestation signals | the boundary that actually holds (rule 1) |
| Monitoring for re-hosted modified APKs | periodic web/app-mirror search for our package name + lookalike domains; takedown requests (host, registrar, search); log findings as risk intel |
| Official-source messaging in-app + on site | "only from get.<domain>; verify checksum" — reduces victim install of trojaned copies |

## 4. Forced update

- Server holds `minSupported` **per flavor** (manifest + platform config).
- Client below floor → **hard-block screen** (no lobby, no play) with update CTA into §2 flow. Block screen ships in P2-era shell and must never regress.
- **API middleware enforcement** (the real boundary): every authenticated request carries app version; below-min ⇒ reject with 426-class `UPDATE_REQUIRED` envelope (error code in `packages/contracts`); client maps it to the block screen. A patched client can skip the screen but not the API floor.
- Raising `minSupported` is an admin platform-config action: audited, four-eyes for prod, with a staged-comms checklist (runbook f for the emergency path).

## 5. Staged rollout & halt

- New prod release starts at low `rollout` (e.g. 5%) → ramp on healthy metrics (crash-free rate via Sentry, error rates, update success) → 100%.
- **Halt:** set `rollout: 0` (stops new adoption; already-updated devices stay — see §7 rollback truth in `ci-cd.md` §7: fix rolls forward).
- Ramp/halt actions are audited platform-config changes.

## 6. Version support policy

- Target: clients at most **N-2** releases behind (~ a few weeks at normal cadence); `minSupported` ratchets accordingly on a schedule, not only in emergencies — keeps the forced-update muscle exercised (rule 16 drill spirit).
- API `/v1` semantics frozen; additive changes only within a version (rule 23) — tolerant of sideload lag inside the support window.
- Security-relevant releases shorten the window aggressively via §4.

## 7. Metrics & alerting (feeds `observability.md`)

| Metric | Alert |
|---|---|
| Update adoption curve per release (versionCode histogram over actives) | ticket: adoption stall (< X% after Y days) |
| Stuck-version cohort (devices pinned to old versionCode) | ticket; investigate device class / delivery failure |
| Update funnel: check → download → verify → install success rates | **page: verify-failure spike** (channel tamper or botched release) |
| `UPDATE_REQUIRED` rejection volume | **page: spike after minSupported change** (forced-update misconfig locking out the fleet) |
| Manifest fetch errors / signature failures | page at threshold |

## 8. Download page basics

Static page on own domain: current version + **SHA-256 checksum displayed**, direct APK link, install instructions incl. unknown-sources/install-permission guidance per Android version, "we are not on Play; only trust get.<domain>" notice, link to verify-checksum howto, support contact. No trackers; served via CDN; page content updated by the release pipeline.
