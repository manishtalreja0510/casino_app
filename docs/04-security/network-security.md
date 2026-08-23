# Network Security

Transport, edge, and ingress design. ADR-013 is the decision record; threat context `./threat-model.md` TB1/TB3. Staging mirrors everything here with its own keys/pins (`../07-operations/environments-and-flavors.md`) so every mechanism is exercised before prod.

## 1. TLS posture

- **TLS 1.2 minimum, 1.3 preferred**, on every listener (edge, origin, webhook ingress, APK hosting, admin). No TLS 1.0/1.1, no plaintext HTTP except redirect-to-HTTPS on the download page host.
- Modern cipher policy (AEAD only on 1.2: ECDHE + AES-GCM/ChaCha20; 1.3 defaults), curve/key sizes per current Mozilla "intermediate" profile; config captured in infra-as-code once OQ-06 is confirmed.
- **HSTS** on all web-facing hosts (download page, admin) — `max-age` ≥ 6 months, `includeSubDomains`; preload considered once the domain set is final. The app itself never dials plaintext, so HSTS matters mostly for browsers (admin SPA, download page).
- OCSP stapling on; session tickets fine (no long-lived resumption secrets across restarts).

## 2. SPKI certificate pinning (app)

- **What is pinned:** SPKI hashes (SubjectPublicKeyInfo, not certificates) — survives reissuance under the same key.
- **Pin-set = current leaf-or-intermediate SPKI + at least one backup key SPKI** whose private key exists but is **not yet deployed** (generated and custodied offline, `./secrets-management.md §7`). Pinning to our own keys, not to a CA — CA-level pins inherit CA breakage.
- **Embedded per flavor:** dev (no pins or dev pins — must not block local proxying for development), staging (staging pin-set), prod (prod pin-set). Pin-sets ship in the build via flavor config; they are public data, not secrets.
- Failure mode: pin mismatch = hard connection failure + a client-side event queued for later report (it can't reach us to report in real time) — surfaced when connectivity via a valid path resumes.

## 3. Pin rotation strategy (normative — a botched rotation must NOT brick installed apps)

**Invariant: always ship pin N+1 before rotating to key N+1.** No key ever goes live that some supported client version hasn't already pinned.

Rotation steps:

1. Generate next backup key **N+2** (offline ceremony). New pin-set = {N (current), N+1 (next), N+2 (new backup)}.
2. Distribute the new pin-set: (a) app release carrying it, and (b) **remote pin-set update** — a pin manifest fetched over the (currently valid) pinned channel, **signed by the offline pinning-update key**; the app verifies against that key's baked-in public key before accepting. Remote update covers users who lag on app updates.
3. **Overlap window:** wait until version telemetry shows the supported fleet holds N+1 (forced-update min-version can shorten the tail — last resort, rule 17 machinery).
4. Deploy serving key N+1 at the edge/origin. Old key N stays pinned (unused) for one further cycle, then drops from the set.
5. Post-rotation: monitor pin-failure signal rate; runbook entry in `../07-operations/runbooks.md`.

**Failure analysis:**

| Failure | Consequence | Recovery |
|---|---|---|
| Rotate to a key nobody pinned | Fleet-wide hard outage of the app | Prevented by the invariant; if it happens anyway: revert serving key (old key still valid — never destroy N until N+1 verified live) |
| Backup key lost | Can't rotate to it | ≥2 forward pins tolerated in set; generate replacement, ship, then rotate |
| Backup key compromised | Attacker with a mis-issued cert for it could MITM | Remove from pin-set via remote signed update + app release; rotate away; CT monitoring (§7) detects mis-issuance |
| Pinning-update key compromised | Attacker can feed pin-sets to apps | Highest-severity key event: forced update to builds with new baked-in verify key; custody design makes this the least likely event (`./secrets-management.md §7`) |
| Remote pin update bug | Apps stuck on stale pins | Stale pins keep working (invariant); forced update as last resort |

Staging runs every rotation first, on its own pins, as a full drill.

## 4. WAF / DDoS layer

- Cloudflare-class WAF/CDN in front of all public hostnames (final vendor with OQ-06 stack confirmation). TLS terminates at edge; edge→origin over TLS with authenticated origin pull or tunnel.
- **Origin not directly reachable:** origin ingress allowlists the edge's ranges or uses an outbound tunnel; origin IPs never in public DNS, never in error messages or headers; no origin IP leakage via mail/misc services on the same host.
- Note the pinning interaction honestly: with edge TLS termination, the app pins the key served at the edge (our custom-uploaded key, so rotation remains ours) — decision detail recorded in ADR-013; the alternative (pass-through/keyless) is revisited if the vendor terms conflict with pin custody.
- Managed WAF rules + bot scoring feed rate decisions; block pages return the standard error envelope shape for API paths.

## 5. Rate limiting tiers

Two enforcement layers: **edge** (volumetric, cheap, coarse) and **app-tier** (Redis token buckets, identity-aware, fine). App-tier classes:

| Dimension | Class | Posture (launch defaults, config-tunable) |
|---|---|---|
| Per-IP | anonymous/auth endpoints | strictest; login/register/refresh/password-reset share the auth class |
| Per-user | authenticated REST | generous for reads; tight for mutations |
| Per-device | signed endpoints | catches multi-account-per-device abuse |
| Per-endpoint-class | auth < financial < gameplay-adjacent REST < reads | financial mutations low absolute caps + idempotency anyway |
| WS | connection attempts per IP/device; events per connection per second | ticket gate throttles handshakes; per-event-type budgets in realtime layer |
| Webhooks | per-provider path | isolated class; floods can't starve player traffic |

Limit hits: 429 + `Retry-After`, audited when on sensitive classes, and counted as risk signals (`../02-domains/fraud-risk.md`). Buckets live in Redis; Redis loss degrades to conservative in-process fallback limits (fail-closed-ish, never unlimited).

## 6. Webhook ingress (P16/P17)

- **Separate path** (dedicated hostname or `/webhooks/*` prefix) with its own WAF rules and rate class; not behind player-auth middleware.
- **Signature verification before any read of the payload's meaning** (rule 8) — provider-specific HMAC/asymmetric scheme via the port adapter; secrets in the secret manager, rotated per provider capability.
- **IP allowlists where the provider supports/publishes them** — defense-in-depth over signatures, not a substitute.
- Idempotency by provider event id (unique constraint) → replay-safe; processing is queue-decoupled (accept fast, verify, enqueue). Details: `./financial-security.md §5`, `../02-domains/payments.md`.

## 7. Request signing (summary)

Financial/sensitive REST calls carry a device-key detached signature (`method|path|body-hash|timestamp|nonce`, ±120 s window, Redis nonce cache). Full treatment and honest scope: `./authentication-security.md §4–5`. Network-level relevance: signing makes a TLS-stripping or edge-logging compromise insufficient to replay financial calls.

## 8. Internal traffic posture

- API ↔ PG ↔ Redis on a **private network** (VPC/private subnets once OQ-06 confirms hosting); no public exposure of data stores, security groups deny-by-default.
- **TLS wherever traffic crosses a trust or network boundary** (managed-DB endpoints, cross-AZ as provided); same-host/same-subnet plaintext acceptable only inside a single private segment and revisited on any topology change.
- Secrets for internal auth (DB/Redis creds) from the secret manager (`./secrets-management.md`); no shared "internal = trusted" assumption in code — internal admin/ops endpoints still authenticate.

## 9. DNS / CAA hygiene

- **CAA records** restricting issuance to our chosen CA(s) on all zones, including the update/download domain.
- **Certificate Transparency monitoring** for our domains — a mis-issued cert is the pinning threat model's trigger event.
- DNSSEC where the registrar/DNS host supports it cleanly; registrar account under 2FA + allowlisted staff (it's admin-plane, TB2).
- No wildcard records pointing at shared infra; dangling-record audits (deprovisioned hosts) in the ops checklist; zone changes audited.
