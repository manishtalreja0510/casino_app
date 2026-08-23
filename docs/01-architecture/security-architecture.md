# Security Architecture

The overview that ties the `docs/04-security/*` detail docs together. Each section names its detail location. Normative rules: `docs/00-project/system-rules.md` (rules 1–3, 14–17 especially). Honest-language policy applies throughout: hardening **raises attacker cost**; nothing here prevents reverse engineering, and no doc, UI, or marketing input may claim otherwise (rule 3).

## 1. Threat posture

- **The client is compromised by definition** (rule 1). The APK is distributed off-store on the open internet; assume it is decompiled, repacked, instrumented (Frida/Xposed), and run on rooted devices and emulators from day one. Nothing client-side is a security boundary: no balance math, no outcome, no timer, no hidden information, no entitlement.
- **The server is authoritative** for every outcome, balance, timer, turn order, and piece of hidden information (rule 2). Client input is untrusted data to validate; hidden info (hole cards) never leaves the server except to its owner, enforced at the `GameDefinition.playerView` contract level.
- **Client hardening is a cost-raiser and a sensor, never a gate.** Root/emulator/hook detection, signature self-check, obfuscation, Play Integrity (OQ-12) — all of it feeds the risk engine as signals; the response is degrade/flag/review, not hard-block (a hard block is trivially found and patched out, and false-positives lock out real users). Detail: `docs/04-security/mobile-app-hardening.md`.
- Primary adversaries, in expected order of appearance: bonus/faucet abusers and multi-accounters; colluding poker players and chip-dumpers; automated play/bots; payment fraudsters and money launderers (real-money phases); protocol attackers probing for information leaks or settlement races; account-takeover attackers; DDoS.

## 2. Trust zones

```
Zone 0  Player device / APK          UNTRUSTED. Public artifact. Holds: device keypair
        (Flutter app)                (Keystore), pinned certs, zero secrets (rule 14).
   │ TLS 1.2+/1.3, SPKI-pinned
Zone 1  Edge: WAF / CDN / DDoS       Semi-trusted traffic filter (e.g. Cloudflare,
        (rate limit tier 1)          OQ-06/ADR-011). Origin unreachable except via edge.
   │ allowlist / tunnel
Zone 2  API plane: NestJS api/ws     Authenticated, authorized, rate-limited, validated.
        containers                   All business + game authority lives here.
   │ private network only
Zone 3  Data plane: PG, Redis,       No public exposure ever. PG = truth; per-schema
        secret manager               roles; ledger privileges minimal (append-only).

Admin plane: apps/admin SPA + admin module — same process, SEPARATE surface:
        mandatory TOTP 2FA, RBAC, IP-allowlist option, own audit trail. Treated as
        a distinct trust zone with the smallest user set and the loudest logging.
```

Each hop only narrows privilege. Compromise of Zone 0 is assumed; compromise of Zone 1 must not expose origin or secrets; Zone 2 holds no long-lived secrets beyond injected env; Zone 3 credentials are per-role and rotated (runbooks).

## 3. Authentication & authorization (summary — `docs/04-security/authentication-security.md`, ADR-013)

- **Access:** JWT ES256, 10-minute TTL, `kid`-rotated signing keys.
- **Refresh:** opaque 256-bit, rotating, one-time-use with **reuse detection → family revocation**, hashed at rest, 30-day sliding window.
- **Device binding:** Android Keystore-backed keypair registered at login; **request signing on financial/sensitive endpoints** (detached signature over method|path|body-hash|timestamp|nonce; Redis nonce cache for replay protection). Raises the cost of token-theft-only attacks: a stolen JWT without the device key can't move money.
- **WS auth:** short-lived one-time ticket via REST, exchanged at Socket.IO handshake; connection bound to session+device.
- Sessions in PG (device, IP, geo, risk flags), cached in Redis; global + per-user revocation. Argon2id passwords. Admin adds TOTP 2FA + RBAC.

## 4. Secrets (summary — `docs/04-security/secrets-management.md`, ADR-011 PROPOSED / OQ-06)

No secrets in code, repo, git history, or binary — **ever** (rule 14, no ADR may override). Anything in the APK is public by definition, so the client holds no secrets, only public keys (pins, manifest-signing pubkey) and its own Keystore-held private key (non-exportable). Backend secrets injected at deploy from the secret manager (OQ-06 — recommendation AWS Secrets Manager, unconfirmed); CI secrets only in the CI store; gitleaks in CI; leak → immediate rotation runbook (`docs/07-operations/runbooks.md`).

## 5. Network security (summary — `docs/04-security/network-security.md`, ADR-013)

- TLS 1.2+/1.3 only; HSTS.
- **SPKI pinning with current + backup pins**; rotation strategy documented so a botched rotation cannot brick installs: backup pin always pre-deployed, remote pin-set update via signed config, forced update as last resort.
- WAF/CDN in front (DDoS absorption, bot rules, edge rate limiting); origin not directly reachable (IP allowlist or tunnel).
- Rate limiting tiers: edge (volumetric) → API classes per-IP/per-user/per-device/per-endpoint (Redis token bucket; auth endpoints strictest) → domain-level velocity limits in the risk engine.

## 6. Financial security (summary — `docs/04-security/financial-security.md`, ADR-008)

Double-entry append-only ledger with DB-enforced invariants (zero-sum deferred constraint trigger, revoked UPDATE/DELETE + trigger guard, non-negative user balances, reversal-only corrections), idempotency keys on every mutating op, ordered row locking — `database-architecture.md §3–4`. **Reconciliation-with-paging** is the detection layer: scheduled jobs verify Σ=0, balance-vs-derived, escrow-vs-open-matches, later PSP statements; any drift pages a human and freezes the affected scope, never auto-corrects (rule 9). Games can't reach money at all — settlement only via game-engine → wallet (rule 10). Withdrawals: KYC gate + risk check + threshold-based manual review.

## 7. Game fairness (summary — `docs/04-security/game-security.md`, ADR-016 PROPOSED)

- All randomness server-side from a CSPRNG behind the `RngService` port; every draw audit-logged (`engine.rng_draws`). The port is the swap point for a **certified RNG (GLI-19-style)** when OQ-01 fixes the certification requirement; commit-reveal provable fairness optional per game (recommended for Crash).
- **Information hiding is structural:** `playerView(state, playerId)` is the only serialization path to clients; hidden info never enters a payload addressed to a non-owner. Tested adversarially (P9 protocol tests: requesting others' hole cards must yield nothing).
- Server-authoritative timers; client timers are cosmetic. Full game-state truth in the PG event log — disputes are replayable.

## 8. Risk engine — the security nervous system (summary — ADR-018, `docs/02-domains/fraud-risk.md`)

**All signals flow to `risk`:** client hardening telemetry (root/hook/emulator/signature, Play Integrity per OQ-12), velocity anomalies, device/IP/network graphs, gameplay statistics (collusion, chip-dumping), auth anomalies (refresh reuse, geo jumps, signing failures), payment patterns. Rules + scores per user/session; actions escalate **allow → flag → limit → review → freeze**. Design principle: **degrade, don't hard-block** on client-side signals — silent degradation and manual review beat giving attackers a clean oracle for what gets detected. Freeze (per-user kill) is reserved for high-confidence or money-endangering cases and always leaves a support path.

## 9. Audit log

Append-only, hash-chained `audit.audit_log` (`database-architecture.md §6`) records every money, auth, admin, game-void, and flag action; head hash exported off-DB. No PII or secrets in the audit log or any log (rule 15). It is both the forensic record and the compliance evidence trail.

## 10. Incident-response levers

- **Kill-switches** (fail-closed flags, `backend-architecture.md §8`): global maintenance, per-game, per-feature, `compliance.real_money_enabled` master gate (default OFF, four-eyes). Drilled in staging; activation pages a human.
- **Forced update** (rule 17, ADR-017): server min-version policy per flavor; below-min clients get a 426-style block with the update path. For an off-store app this is the **only security-patch channel** — it must always work, and no release may break the version-check/update path of shipped clients. Signed release manifest + checksum verification defend the update channel itself (`docs/04-security/network-security.md`, P13).
- Runbooks (`docs/07-operations/runbooks.md`): secret-leak rotation, pin rotation, freeze-scope procedures, PSP/webhook incident handling.

## 11. Per-phase security gates

`docs/04-security/security-checklist.md` is **mandatory in every phase plan** — each phase runs the checklist before completion (rule 28); failing items block the phase (rule 18). High-risk phases add: threat-model review (P3 auth), constraint/property tests as gates (P4 ledger), adversarial protocol tests (P9), and P14 is the dedicated gate — full checklist review + external pen test + remediation — that must pass before any real-money phase (P18) completes.

## 12. Detail map (`docs/04-security/`)

| Doc | Covers |
|---|---|
| `threat-model.md` | STRIDE threat catalog per trust boundary, compromised-client scenarios, top-10 ranked risks |
| `authentication-security.md` | token model, refresh rotation/reuse detection, device binding, request signing, WS tickets, session mgmt |
| `network-security.md` | TLS, SPKI pinning + rotation, WAF/edge, origin isolation, rate limiting, update-channel transport security |
| `mobile-app-hardening.md` | obfuscation, root/emulator/hook detection, signature self-check, Play Integrity (OQ-12), signal reporting |
| `financial-security.md` | ledger invariants, idempotency, locking, reconciliation, withdrawal controls |
| `game-security.md` | RNG service, certification path, commit-reveal, playerView information hiding, dispute replay |
| `secrets-management.md` | secret manager usage (OQ-06), rotation, CI secrets, leak response |
| `security-checklist.md` | the per-phase mandatory checklist |
