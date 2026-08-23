# Domain: Authentication (`auth` module)

Phase: **P3**. ADR: **ADR-013** (network security: token model, request signing, pinning). Depends on P1 (audit, flags, rate-limit skeleton) and P2 (auth screens from ui_kit). Enables P4, P5.

Purpose: prove *who* is calling (account), *from what* (device), and *that the call is fresh* (anti-replay) — the trust plumbing every money and game action rides on. The client is untrusted (rule 1); auth binds requests to server-held state, it never delegates decisions to the client.

## 1. Owned data (tables)

| Table | Key contents | Notes |
|---|---|---|
| `auth_credentials` | user_id (FK users), email (unique, citext), password_hash (Argon2id), password_updated_at, failed_attempt_state | Argon2id params versioned in the hash string; rehash-on-login when params change |
| `devices` | id (UUIDv7), user_id, public_key (device signing key, SPKI DER), key_registered_at, platform, app_version, attestation_snapshot, status (active/revoked) | one row per install; Keystore-backed key never leaves the device |
| `sessions` | id, user_id, device_id, created_at, last_seen_at, ip, ip_geo (country/region/asn), risk_flags, status (active/revoked), revoked_reason | PG is truth; Redis cache for hot lookups |
| `refresh_tokens` | id, family_id, session_id, token_hash (SHA-256), issued_at, expires_at, used_at, replaced_by | opaque 256-bit value only ever stored hashed |
| `ws_tickets` | (Redis only) ticket_hash → {user_id, session_id, device_id}, TTL ~30s, one-time | not persisted; a ticket that outlives Redis is simply invalid |
| `signing_nonces` | (Redis only) `nonce:{deviceId}:{nonce}` SETNX, TTL = accept window | replay cache |

`users` rows (profile, account state) belong to the `users` module (`./users.md`); `auth` reads account state via the exported users service.

## 2. Exposed services / API surface

REST (`/api/v1/auth/*`): `POST /register`, `POST /login`, `POST /token/refresh`, `POST /logout` (current session), `POST /logout-all`, `POST /devices/register`, `GET /sessions`, `DELETE /sessions/:id`, `POST /ws-ticket`, `POST /password/change`, password-reset pair (`/password/forgot`, `/password/reset` — email-token based, same rate class as login).

In-process (exported to other modules): `AuthGuard` (JWT verify + session-alive check), `SignatureGuard` (request-signing verify), `SessionService.revoke(userId | deviceId | sessionId)`, `AccountStateGuard` (enforces states from §7), domain events `auth.login`, `auth.logout`, `auth.new_device`, `auth.refresh_reuse_detected`, `auth.lockout`.

## 3. Token model

**Problem.** Off-store Android app; long-lived login UX; stolen-token damage must be bounded; server must be able to kill any session instantly.

**Approach (canonical).**
- **Access token:** JWT **ES256**, **10-min TTL**, `kid`-rotated signing keys (JWKS internal; old key kept verifying through overlap window). Claims: `sub` (user), `sid` (session), `did` (device), `iat/exp`, `ver`. No roles/balances/entitlements in the token — those are server lookups.
- **Refresh token:** opaque **256-bit random**, **rotating, one-time-use**. Each refresh issues a new token in the same `family_id` and marks the old one used. **Reuse detection:** presenting an already-used token ⇒ the whole family (and its session) is revoked, `auth.refresh_reuse_detected` audited, user notified (P11). Stored **hashed (SHA-256)** at rest. **30-day sliding** expiry: each successful rotation extends family life; absolute cap enforced per-family.
- Access tokens are verified statelessly *plus* a Redis session-alive check on sensitive endpoint classes, so revocation is effective within one cache TTL (≤30s) and immediately on financial endpoints (which always hit the check).

**Alternatives.** Long-lived JWT + denylist (denylist grows unbounded, revocation race); stateful bearer tokens only (per-request PG hit); refresh without rotation (stolen refresh = 30 days of quiet access). **Why:** rotation + reuse detection turns refresh theft into a detectable, self-limiting event. **Trade-off:** refresh endpoint must serialize per family (row lock on family) to avoid legitimate-parallel-refresh false positives; a small retry window for network-lost responses is allowed (grace: the *immediately* superseded token may be replayed once within ~30s to cover lost responses — anything older is reuse).

## 4. Device registration & request signing

- At first login on an install, the app generates a **P-256 keypair in Android Keystore** (StrongBox where available, key non-exportable) and registers the public key → `devices` row. The private key never leaves hardware.
- **Signing spec (sketch):** header `X-Signature` = ES256 signature over the canonical string `method|path|SHA256(body)|timestamp|nonce`, plus headers `X-Timestamp` (unix ms), `X-Nonce` (128-bit random), `X-Device-Id`. Server verifies: device active + belongs to token's `did`; |now − timestamp| ≤ **±120s** accept window; nonce unseen (Redis SETNX, TTL = window ×2); signature valid against registered key.
- **Endpoint classes requiring signature:** financial mutations (faucet, buy-in intents, later deposits/withdrawals P17), device & session management, password/credential changes, KYC start (P16), RG limit changes. Not required: reads, lobby browsing, gameplay WS actions (the WS connection itself is session+device-bound at handshake — signing every game action would add latency for no boundary gain).

**Why signing at all:** raises the cost of using a stolen bearer token off-device from "copy a string" to "extract a hardware-backed key" (practically: run on the victim device). Honest framing: cost-raiser, not a boundary — a fully compromised device signs whatever malware asks (rule 3); those cases are the risk engine's job.

## 5. WS ticket issuance

`POST /auth/ws-ticket` (authenticated, signed) → one-time opaque ticket, TTL ~30s, stored hashed in Redis with `{user, session, device}`. Socket.IO handshake presents the ticket; server atomically consumes it (GETDEL) and binds the connection to session+device. Revoking a session force-disconnects its sockets (realtime module subscribes to `auth.session_revoked`). Rationale: keeps JWTs out of WS query strings/logs and gives the handshake the same session-binding as REST. Details: `../01-architecture/realtime-architecture.md`.

## 6. Session lifecycle

PG `sessions` is truth; Redis caches `session:{sid}` → status (TTL ≤30s). Created at login (device, ip, ip-geo, risk flags from risk module snapshot). `last_seen_at` updated lazily (batched, ≥1/min). Revocation levels: **single session** (user or admin), **per-device** (device compromise/reinstall — also revokes device row + its refresh families), **global** ("logout everywhere" — all sessions + families for the user). Every revocation: PG update → Redis cache bust → WS disconnect → audit event.

## 7. Account states & enforcement points

States (owned by `users`, enforced here): `active` · `suspended` (admin/risk) · `self_excluded` (RG, with term) · `closed`.

| State | Login | Refresh | Gameplay/matchmaking | Financial ops | Notes |
|---|---|---|---|---|---|
| active | ✓ | ✓ | ✓ | ✓ | |
| suspended | ✗ (explicit error) | ✗ | ✗ | ✗ | existing sessions revoked on transition |
| self_excluded | ✓ (account/support/RG screens only) | ✓ | ✗ | deposits/faucet ✗; withdrawals ✓ (must remain possible) | enforced by `AccountStateGuard` + matchmaking/wallet checks; see `./responsible-gaming` docs (P10) |
| closed | ✗ | ✗ | ✗ | ✗ | see `./users.md` closure process |

State transitions immediately revoke/degrade live sessions (cache bust + WS notice), not just future logins.

## 8. Rate limiting & lockout

Redis token buckets per **IP**, **user**, **device**, and **endpoint class**; auth class strictest (login/refresh/register/password-reset). Progressive lockout on failed logins per (account, IP): soft delays → temporary account lock (e.g. 15 min after N failures) with generic error text (no user-enumeration: register/forgot-password respond identically for existing/unknown emails). Lockouts audited and fed to risk. CAPTCHA/proof-of-work hook reserved (candidate for P10 wiring). WAF/CDN in front absorbs volumetric abuse (ADR-013).

## 9. Geo-check scaffold (record now, enforce post-P15)

Every login/session records IP-geo (country, region, ASN, VPN/proxy heuristic score) on the session row. Enforcement is a config-driven check (`platform` module jurisdiction config) that is **off** until OQ-01 resolves at P15/P18; then it blocks per policy (`../06-compliance/jurisdiction-matrix.md`) and cross-checks declared address + payment country (P18). Building the recording now means enforcement is a config flip plus policy table, not a retrofit (rule 13).

## 10. Audit events

`auth.register`, `auth.login` (success/fail + reason class), `auth.lockout`, `auth.logout`, `auth.session_revoked` (scope, actor), `auth.refresh_rotated` (family id only), `auth.refresh_reuse_detected`, `auth.device_registered`/`device_revoked`, `auth.password_changed`/`reset`, `auth.signature_rejected` (reason: skew/nonce/invalid), `auth.geo_recorded` (on anomaly). All to the hash-chained audit log (rule 15); no tokens, no emails in payloads — opaque IDs only.

## 11. Threats & mitigations (summary)

| Threat | Mitigations |
|---|---|
| Credential stuffing | Argon2id, per-IP/account buckets + lockout, uniform error responses, breach-password check candidate, WAF bot rules, risk signals on distributed patterns |
| Token theft (access) | 10-min TTL, session-alive check on sensitive classes, signing requirement makes token useless off-device for financial ops |
| Token theft (refresh) | hashed at rest, rotation + one-time-use, reuse ⇒ family revocation + notify |
| Replay | timestamp window + one-time nonce cache; WS ticket one-time consume |
| Session fixation | session ids server-generated post-auth only, never accepted from client; new session per login; WS binds via one-time ticket |
| Phishing/MITM | TLS + SPKI pinning (ADR-013); no tokens in URLs/logs |
| Malware on device | out of scope for auth (rule 1) — hardening signals → risk engine (P10) |

## 12. Edge cases

- **Clock skew on signing:** ±120s window; on rejection the error returns server time so the client computes an offset and retries once (offset cached; cosmetic only — server never trusts client time). Persistent skew beyond retry → surfaced as device-clock UX error.
- **Key rotation on device change/reinstall:** Keystore keys don't survive uninstall or backup-restore to new hardware. Reinstall ⇒ login re-runs device registration (new device row, new keypair); old device row idles and is revocable; N-devices-per-account cap + "new device" notification (P11) + risk signal. No key escrow — a lost key is a new device, never a restored one.
- **JWT signing-key (`kid`) rotation:** overlap window where old kid still verifies; tokens are 10-min so the window is short; rotation runbook in `../07-operations/runbooks.md`.
- **Refresh response lost in transit:** single-replay grace (§3) avoids logging users out on flaky networks without weakening reuse detection.
- **Redis loss:** sessions fall back to PG reads (slower, correct); nonce cache loss shrinks replay protection to the timestamp window for its TTL — accepted (window is small), noted in ADR-005 limits.

## 13. Phase mapping & open questions

- **P3:** everything above except enforcement of geo (scaffold only) and player 2FA (deferred; admin TOTP is P12).
- Post-P15: geo enforcement (P18), KYC-gated states interplay (P16).
- OQs touched: **OQ-01** (geo enforcement policy), **OQ-12** (attestation snapshot as risk signal, never gate).
- Candidate OQ: player-facing 2FA (TOTP/passkeys) timing and whether withdrawal ops should require step-up auth — recommend deciding by P17 planning; noted for consistency pass.
