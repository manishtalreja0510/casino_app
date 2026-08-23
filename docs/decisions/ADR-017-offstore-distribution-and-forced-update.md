# ADR-017: Off-Store Distribution & Forced Update

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

Play Store policy makes off-store the only Android channel for this product at launch. That removes the store's update pipeline and its (limited) supply-chain guarantees: we must build our own trustworthy download/update channel, and we must be able to force-patch a fleet of sideloaded clients — for an off-store real-money app, forced update **is the security-patch channel** (rule 17 ⛔).

## Decision

- **Hosting:** versioned APKs on our own domain over HTTPS (behind the WAF/CDN), with published **SHA-256 checksums** and a **manifest signed by an offline-custodied key** (separate from the APK signing key) listing versions, hashes, min-OS, and rollout metadata.
- **In-app updater:** version-check endpoint → download → verify checksum **and** manifest signature against a public key pinned in the app → prompt user-driven install (Android additionally verifies the APK signature on install; the applicationId+signing-key pair per flavor is from ADR-012). No install prompt for anything that fails verification — this is the channel anti-tamper.
- **Forced update:** server-side `minSupportedVersion` per flavor; below it, every API response is a 426-style `UPDATE_REQUIRED` envelope with update instructions — enforced at the API layer so it cannot be bypassed by skipping the check screen. The version-check/update path is covered by rule 17: **no change may ever break it for already-shipped clients**.
- **Staged rollout:** manifest carries a rollout percentage; clients self-select deterministically (device-id hash) so a bad release is caught before fleet-wide exposure.
- **Monitoring for re-hosted/modified APKs:** periodic scanning of APK mirror sites for our package id, signature comparison, and takedown process; server-side attestation/behavioral signals feed the risk engine (ADR-018) since re-signed clones will fail signature self-check and device attestation.

## Alternatives considered

- **Third-party app stores** (Samsung Galaxy Store, Aptoide, etc.) — rejected at launch: gambling policies and geo constraints vary per store and per jurisdiction (OQ-01), adding review dependencies without replacing our own channel. Re-evaluate post-license as a *supplementary* channel.
- **MDM-style silent updates** — impossible: silent install requires privileged/device-owner status an ordinary consumer app cannot have.
- **No forced update (advisory-only prompts)** — rejected: leaves an unpatchable fleet on a security-critical, money-moving app; sideload lag makes this worse, not better.

## Consequences

- Full ownership of update reliability: hosting, manifest signing ceremony (offline key), and updater QA are on us permanently; the updater itself is the one component that must never regress (tested in staging every release, per ADR-012).
- Two offline keys to custody (APK signing, manifest signing) — deliberate separation so a hosting compromise cannot forge installable updates.
- 426 enforcement means old clients degrade to a hard "update to continue" — acceptable and intended; API versioning stays additive within `/v1` to keep the *update path itself* tolerant of lag (rule 23).
- Staged rollout + forced update interact: a forced security patch overrides staging percentages.

## Links

- ../00-project/system-rules.md (rules 17, 23), ../00-project/open-questions.md (OQ-01, OQ-12)
- ../01-architecture/infrastructure-architecture.md, ../04-security/mobile-app-hardening.md, ../04-security/threat-model.md
- ADR-012-environment-and-flavor-strategy.md, ADR-013-network-security-model.md, ADR-018-fraud-risk-engine-approach.md · Phase: P13
