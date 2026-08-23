# ADR-013: Network Security Model

**Status:** ACCEPTED
**Date:** 2026-08-23

## Context

An off-store Android app moving real money is a priority target: hostile networks (MITM on public Wi-Fi, rogue CAs), stolen tokens, replayed financial requests, credential stuffing, and DDoS. The client is compromised by definition (rule 1); network security must therefore hold with zero trust in the device while not bricking a sideloaded fleet that updates slowly.

## Decision

- **Transport:** TLS 1.2+ / 1.3 only, modern ciphers; WAF/CDN (e.g. Cloudflare) in front for DDoS absorption; origin not directly reachable (IP allowlist / tunnel).
- **Certificate pinning:** SPKI pinning in the app with **current + backup** pins. Rotation strategy is part of the decision: the backup key is pre-generated and pre-pinned before it is ever deployed; pin-set updates can be delivered remotely via a **signed config** (verified against a key pinned in the app, offline-custodied); forced update (ADR-017) is the last-resort recovery channel. Invariant: **a botched rotation must not brick installs** — rotations are rehearsed in staging (ADR-012) against its own pins.
- **Tokens:** access = JWT **ES256**, 10-minute TTL, `kid`-rotated signing keys. Refresh = opaque 256-bit, **rotating, one-time-use with reuse detection** → family revocation on reuse; hashed at rest; 30-day sliding window.
- **Device binding:** Android Keystore-backed keypair registered at login; hardware-backed where available. Sessions bound to device records in PG.
- **Request signing (financial endpoints):** detached signature header over `method|path|body-hash|timestamp|nonce` using the Keystore private key; server verifies signature, timestamp skew, and replays via a Redis nonce cache. A stolen bearer token alone cannot move money.
- **Rate limiting, layered:** per-IP, per-user, per-device, per-endpoint-class (auth strictest) — Redis token buckets behind the WAF's own coarse limits.
- **WS:** one-time WS ticket via REST exchanged at Socket.IO handshake; connection bound to session + device.

## Alternatives considered

- **No pinning** — rejected: MITM on hostile networks/rogue-CA scenarios is a realistic threat for a gambling app, and off-store users skew toward risky networks.
- **Full mTLS** — rejected: client-certificate provisioning/rotation on sideloaded Android (no MDM, no store channel) is impractical; Keystore request signing gives the per-device asymmetric property without the cert lifecycle.
- **Long-lived access tokens** — rejected: widens the stolen-token window; 10-min + rotating refresh with reuse detection bounds it and detects theft.
- **HMAC shared-secret request signing** — rejected: any shared secret ships in the APK and is extractable; asymmetric Keystore keys keep the private key non-exportable on-device.

## Consequences

- MITM, token theft, and replay each require defeating an independent layer; financial mutations need a live device key.
- Pinning imposes permanent key-ceremony discipline; the backup-pin + signed-remote-update + forced-update ladder is the price of not bricking installs.
- ES256 key rotation via `kid` means old tokens die naturally within 10 minutes.
- Keystore signing adds latency and an integration burden on financial calls only; accepted.
- Devices with broken Keystore implementations need a documented degrade path (risk-flagged, limited) — degrade, don't hard-block.

## Links

- ../04-security/authentication-security.md, ../04-security/threat-model.md, ../01-architecture/security-architecture.md
- ../02-domains/authentication.md, ../03-api/api-conventions.md
- ADR-012-environment-and-flavor-strategy.md, ADR-017-offstore-distribution-and-forced-update.md · Phases: P3, P5, P13, P14
