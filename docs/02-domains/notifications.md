# Domain: Notifications (`notifications`)

Phase: **P11** · Transport question: **OQ-09** (recommendation: FCM where Play services exist + in-app WS/poll fallback; nothing critical push-only). Rides the P5 real-time layer for in-app delivery.

## 1. Purpose

One domain owns all player messaging: what may be sent, over which transports, with what guarantees. Other domains emit typed triggering events; they never talk to a transport directly. Off-store Android makes push unreliable by construction (FCM absent on de-Googled devices), so the design guarantees delivery through the in-app inbox and treats push as best-effort acceleration.

## 2. Notification classes

| Class | Examples | Guarantee | Opt-out |
|---|---|---|---|
| **Critical / security** | new-device login, password/refresh-family revocation, freeze notice, forced-update notice | **never push-only** — always written to in-app inbox first; push/email are additional attempts | **No** (non-optoutable) |
| **Critical / RG** | limit reached, exclusion confirmation, reality-check follow-ups | same as above | **No** (non-optoutable — rule 12) |
| **Transactional** | withdrawal status (P17), KYC verdict (P16), match voided/refunded | inbox-backed; push+email attempted | partial (channel choice, not content) |
| **Informational** | match start, your-turn nudge, table available | best-effort, may be push/WS-only, expiring | Yes, per category |

Rule: a notification's class is fixed in the catalog, not chosen by the emitter at send time — prevents "marketing dressed as security".

## 3. Transport abstraction

Ports, in adapter pattern like PSP/KYC:

- **In-app inbox + WS (guaranteed baseline):** `notifications_inbox` rows in PG (truth); live delivery over Socket.IO `user:{userId}` room when connected; fetched via REST on app open/reconnect. This is the only transport allowed to satisfy a critical-class guarantee.
- **`PushTransportPort` → FCM adapter** where Play services present (OQ-12/OQ-09 reality: works for sideloaded apps on Play-services devices). Device capability recorded at device registration; absence → skip silently. Self-hosted push (UnifiedPush/ntfy) only if de-Googled share proves material (OQ-09 stance) — port shape already accommodates it.
- **`EmailTransportPort`** — provider deliberately unchosen (transactional email provider selection is low-risk; pick at P11 planning, record in phase plan; escalate to a candidate OQ only if data-residency from OQ-01 constrains it).
- **SMS: not at launch.** Port intentionally not defined; adding it later is additive.

## 4. Templates & catalog

- Versioned templates in PG (`notification_templates`: key, version, class, per-channel bodies, locale variants), i18n-ready (ICU-style placeholders; launch locale set small, structure ready). Rendered server-side; rendering inputs are opaque ids + already-safe strings.
- **No PII in push payloads** (FCM payloads transit Google): the push payload is a *reference* — `{type, notification_id}` plus a generic title ("New login to your account"). Content is fetched over the authed REST channel when the app opens the notification. Same discipline as logs (rule 15).
- Template changes are versioned, not edited in place — inbox rows pin the template version they were rendered with (dispute/compliance evidence).

## 5. Preferences

`notification_prefs` per user: per-category × per-channel toggles. **Non-optoutable classes: critical/security and critical/RG** — UI shows them locked. Informational categories individually mutable. Quiet hours (informational only) as config-ready field; ship if cheap at P11.

## 6. Triggering events catalog (v1)

| Event | Source domain | Class |
|---|---|---|
| new-device login | `auth` | critical/security |
| refresh-token reuse detected / sessions revoked | `auth` | critical/security |
| RG limit reached / exclusion active | `responsible-gaming` | critical/RG |
| account frozen by risk (with support path) | `risk` | critical/security |
| forced-update notice (grace warning before min-version block) | `platform` | critical/security |
| match start / your-turn | `matchmaking` / `game-engine` | informational |
| match voided + refund issued | `game-engine` | transactional |
| KYC verdict (P16) | `kyc` | transactional |
| deposit confirmed / withdrawal status change (P17) | `payments` | transactional |

Emission is an in-process domain event → `notifications` consumer; the domain owns fan-out, dedup, and channel selection. New triggers = catalog entries + template, no transport code.

## 7. Delivery tracking & retry

- `notification_deliveries`: notification_id × channel → state (`pending → sent → delivered? → failed`), attempt count, last error. FCM gives coarse acks; WS delivery confirmed by client ack (P5 seq/ack machinery); email by provider webhook where available.
- Retries via BullMQ (idempotent jobs, per rule/jobs baseline): bounded exponential backoff per channel; permanent channel failure is fine for non-critical; critical classes are already inbox-guaranteed so channel failure only loses acceleration, never the message.
- Inbox read-state tracked (`read_at`) — feeds "unread" badge and lets security notices assert "seen".

## 8. Rate limiting (no notification storms)

- Per-user per-category collapse windows (e.g. your-turn nudges collapse to latest; table-available capped per hour) — Redis counters.
- Global per-channel throughput caps (protect FCM/email sender reputation).
- Storm breaker: mass-trigger events (maintenance kill-switch, forced update) go through a batched announcement path, not N individual sends.
- Critical/security and RG classes are exempt from *suppression* but still deduplicated (same event id sends once — idempotency key on emit).

## 9. Phase mapping

| Phase | Scope |
|---|---|
| P5 | WS `user:{id}` room exists (delivery rail) |
| **P11** | domain tables, catalog + templates, inbox + WS baseline, FCM adapter, email port + minimal adapter, prefs, tracking/retry, rate limiting, triggers: new-device login, match start/turn, RG/security notices, forced-update notice |
| P12 | admin: template management, send-log browsing (RBAC `ops`/`support`) |
| P16/P17 | KYC + payment trigger wiring |
| P13 | forced-update notice path exercised end-to-end (rule 17 dependency) |

Testing (P11 acceptance): new-device login + match-start delivered in-app on all devices, via FCM where available; de-Googled device receives everything on next app open; push payload dump contains no PII.
