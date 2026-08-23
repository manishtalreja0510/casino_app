# Authentication Security

Security-properties deep-dive on the auth design. The *design* (tables, endpoints, lifecycle) is `../02-domains/authentication.md`; ADR-013 records the decision. This doc answers: what does each mechanism defend against, what does it not, and how do we verify. Threat context: `./threat-model.md` TB1/TB2.

## 1. Password storage — Argon2id posture

- **Algorithm:** Argon2id only (hybrid mode resists both GPU cracking and side-channels). No bcrypt/scrypt/PBKDF2 fallbacks; imported hashes don't exist (greenfield).
- **Parameter posture:** tuned to a target of **~50–100 ms per hash on production API hardware**, starting from at least OWASP-current minimums (order of: m=64 MiB, t=3, p=4 — final numbers fixed by benchmark in P3 and recorded in the phase plan; never hardcode in docs what hardware decides). Parameters are **versioned inside the hash string**; login transparently **rehashes on parameter upgrade**.
- **Per-hash salt** (library-generated, 16 B+); no pepper at launch — a pepper adds secret-management coupling for marginal gain while the DB and secret manager share a blast radius. Revisit if DB-only compromise becomes a distinct scenario (candidate hardening, not planned).
- **Verification cost is a DoS surface:** login/registration are the strictest rate class (§3) precisely because each attempt costs us CPU by design.

## 2. What the token model defends (and doesn't)

| Property | Mechanism | Limit |
|---|---|---|
| Stolen access token has small value | ES256 JWT, **10-min TTL**, session-alive check on sensitive classes | 10-min window on non-sensitive reads |
| Signing-key compromise is recoverable | `kid` rotation, JWKS internal, overlap window for old-key verification | Requires detection; rotation runbook (`../07-operations/runbooks.md`) |
| Stolen refresh token is self-limiting | One-time-use rotation + reuse detection → family revocation | Thief who wins the race uses the session until the victim's client refreshes (hours at most); then detection fires |
| DB dump doesn't yield usable tokens | Refresh tokens stored **SHA-256-hashed**; access tokens never stored | — |
| No token grants authority by itself | No roles/balances/entitlements in JWT claims; server lookups only | — |

**Refresh rotation + reuse detection — sequence (text):**

```
Client                         Server
  | POST /token/refresh (R1)     |
  |----------------------------->| lock family row
  |                              | R1 unused? -> mark R1 used, issue R2 (same family_id),
  |                              |   new access JWT; slide family expiry
  |<--- {access, R2} ------------|
  ... later, attacker replays R1 ...
  | POST /token/refresh (R1)     |
  |----------------------------->| R1 already used AND outside 30s lost-response grace
  |                              | -> REUSE DETECTED: revoke entire family + session,
  |                              |    audit auth.refresh_reuse_detected, notify user (P11)
  |<--- 401 (generic) -----------|
```

Both the legitimate user and the thief are logged out — deliberately: we cannot distinguish which holder is legitimate, so the family dies and the real user re-authenticates with credentials. The **~30 s single-replay grace** for the *immediately superseded* token covers mobile networks losing the response; anything older or twice-replayed is reuse. Family operations serialize on a row lock to avoid false positives from parallel refreshes.

**Client-side storage:** refresh token and any cached material live in **Android Keystore-backed encrypted storage** (EncryptedSharedPreferences-class); never in plain files, never logged, excluded from backups (`android:allowBackup=false`, no key material in auto-backup). This raises cost for on-device malware without root; a rooted device reads anything — that case is the risk engine's, not storage's (rule 1).

## 3. Credential-stuffing & brute-force defenses

Layered, cheapest first:

| Layer | Control | Notes |
|---|---|---|
| Edge | WAF bot rules, volumetric limits | `./network-security.md §5` |
| App rate limits | Redis token buckets per IP / user / device / auth endpoint class (strictest tier) | precede Argon2id work — cheap rejection before expensive hashing |
| Lockout curve | Per (account, IP): progressive delays (e.g. 0/0/2s/5s/15s), then temporary account lock (~15 min after N failures), doubling on repeat | curve parameters config-tunable; audited; feeds risk engine |
| Enumeration resistance | Register / login / forgot-password return identical shape+timing for existing vs unknown emails | tested in P3 |
| Breach-password screening | **Consideration, recommended:** k-anonymity range check (HIBP-style) at registration/password-change; reject known-breached passwords. Adds an external dependency → wire behind a port, fail-open with a risk signal if unavailable | decide in P3 planning; candidate for P10 hard-enforcement |
| Detection | Lockout + failure-pattern signals into risk engine; distributed-stuffing detection (many accounts, few attempts each) is a P10 rule | residual: low-and-slow stuffing — bounded by breach screening + reuse detection downstream |

## 4. Device binding & request signing — honest scope

Mechanism per `../02-domains/authentication.md §4` (Keystore P-256 key, detached signature over `method|path|body-hash|timestamp|nonce`).

- **Defends:** replay of a stolen bearer/refresh token **from another device** — the attacker has the string but not the non-exportable hardware key, so signed (financial/sensitive) endpoints reject them. Also gives every financial request a nonce (replay cache) and timestamp (freshness).
- **Does not defend:** a **fully compromised device** — malware with control of the victim device asks Keystore to sign whatever it wants. No client mechanism fixes this (rule 1); mitigations there are behavioral: risk signals, velocity limits, withdrawal review (`./financial-security.md §6`).
- **Key lifecycle:** key generated at first login per install; reinstall = new device row (old one revocable); server can revoke a device, killing its sessions and refresh families.

## 5. Clock skew

Signed requests carry client timestamps; mobile clocks drift. Accept window **±120 s** against server time; nonce cache TTL = 2× window so a nonce outlives its usable period. Rejections return a distinct error code carrying the server time so a skewed client can **correct its offset and retry once** (offset held in memory, never trusted for anything but resigning). Persistent skew rejections are a risk signal (deliberate timestamp games look identical to broken clocks — the risk engine weighs frequency). JWT `iat/exp` validation uses standard small leeway (≤30 s); refresh flow is unaffected by skew (opaque tokens, server clock only).

## 6. WS ticket security

- One-time opaque ticket via authenticated+signed REST; **TTL ~30 s**; stored hashed in Redis; **atomically consumed (GETDEL)** at Socket.IO handshake — a replayed ticket finds nothing.
- Keeps JWTs out of WS URLs (query strings leak into proxy/CDN logs).
- The socket inherits session+device binding; session revocation force-disconnects sockets. A Redis loss invalidates outstanding tickets — clients just re-request (fail-closed).

## 7. Session fixation & hijack defenses

- Session IDs are **server-generated UUIDv7 only**, issued at login; nothing client-supplied ever names a session → no fixation surface.
- Hijack limited by: short access TTL, session-alive checks, device binding on sensitive calls, IP/geo recorded per session with anomaly signals (impossible travel, ASN jumps → risk engine, step-up or revoke).
- Password change / reset / device revocation revoke all other sessions of the account by default.

## 8. Logout-everywhere & revocation latency

Revocation levels (session / device / global) per `../02-domains/authentication.md §6`. Latency budget:

| Path | Latency | Why |
|---|---|---|
| Financial + sensitive endpoints | **Immediate** | always hit the session-alive check (Redis, cache-busted on revoke; PG fallback on cache miss) |
| Other REST | ≤ Redis cache TTL (**≤30 s**) | stateless JWT verify + cached session status; TTL is the trade-off knob between PG load and revocation lag |
| WebSocket | Immediate | revocation event → force-disconnect via realtime module |

Trade-off stated honestly: a revoked user can read non-sensitive data for up to 30 s. Acceptable; anything that moves money or reveals hidden info is in the immediate class. Redis outage → sensitive classes fall back to PG (slower, still correct); never fail-open.

## 9. Admin authentication differences (P12)

| Property | Player auth | Admin auth |
|---|---|---|
| 2FA | not at launch (player 2FA later) | **mandatory TOTP** at enrollment, verified per login and per sensitive action re-auth |
| Access TTL | 10 min | ≤10 min, **idle timeout ~15 min**, absolute session ≤8 h |
| Refresh | 30-day sliding | none or short (re-login daily); no long-lived admin refresh families |
| Network | public via WAF | IP allowlist option; separate rate class |
| Authz | account-state guards | RBAC per endpoint × role, deny-by-default; four-eyes on designated mutations |
| Audit | audit events | **every** mutation + PII **read**-audits |
| Recovery | email reset | no self-service reset — another superadmin re-enrolls, four-eyes, audited |

## 10. Account recovery as attack surface

Recovery is the classic auth bypass; kept deliberately narrow at launch:

- **Email reset only.** Single-use token (256-bit, hashed at rest, ~30 min TTL), sent to the verified address; consuming it revokes other sessions and all refresh families.
- **No security questions, no SMS reset, no support-channel reset** at launch (social-engineering surfaces). Support can only trigger the same email flow.
- Same strict rate class as login; identical response for unknown emails; every request and consumption **audit-logged**; a reset from a new device/geo emits a risk signal + user notification (P11).
- Changing the email address itself requires a fresh password + (once sessions exist long enough) confirmation to the old address — an account with stolen email access is the residual risk; withdrawal-destination changes therefore carry their own re-auth + delay (`./financial-security.md §6`).

## 11. Verification hooks

P3 must land attack tests, not just happy paths: reuse→family-revocation test, signature tamper/replay/skew tests, lockout curve test, enumeration-timing test, revocation-latency test (financial endpoint rejects within one request of revoke). These are pinned in `./security-checklist.md` and re-run in P14.
