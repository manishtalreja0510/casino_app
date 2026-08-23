-- 0002_auth — P3 auth & identity.
-- See docs/02-domains/authentication.md and ADR-013.
-- ROLLBACK: DROP SCHEMA IF EXISTS auth CASCADE;

CREATE SCHEMA IF NOT EXISTS auth;

-- Account identity. Deliberately minimal PII: email is the only personal datum, and it
-- never appears in logs or audit payloads (rule 15).
CREATE TABLE IF NOT EXISTS auth.users (
  id            uuid PRIMARY KEY,
  email         text        NOT NULL,
  display_name  text        NOT NULL,
  -- active | suspended | self_excluded | closed. Checked on EVERY authenticated request,
  -- not only at login, so a suspension takes effect immediately (docs/02-domains/users.md).
  status        text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'self_excluded', 'closed')),
  -- KYC level. OQ-03 deferred verification, so everyone sits at L0 — the column exists now
  -- so P16 raises levels without touching call sites.
  kyc_level     text        NOT NULL DEFAULT 'L0' CHECK (kyc_level IN ('L0', 'L1', 'L2')),
  country       text        NULL,        -- last observed, for the geo scaffold (rule 13)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: Alice@x.com and alice@x.com are one account.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON auth.users (lower(email));

CREATE TABLE IF NOT EXISTS auth.credentials (
  user_id       uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  password_hash text        NOT NULL,     -- Argon2id, encoded parameters included
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Device binding (ADR-013). The public half of an Android Keystore-backed P-256 key.
CREATE TABLE IF NOT EXISTS auth.devices (
  id            uuid PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  public_key    text        NOT NULL,     -- SPKI, base64
  label         text        NULL,
  attestation   jsonb       NULL,         -- hardening signals at registration (P10 consumes)
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NULL,
  revoked_at    timestamptz NULL
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON auth.devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  device_id     uuid        NULL REFERENCES auth.devices (id) ON DELETE SET NULL,
  ip            inet        NULL,
  country       text        NULL,         -- geo scaffold: recorded now, enforced post-licensing
  user_agent    text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz NULL,
  revoked_reason text       NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON auth.sessions (user_id) WHERE revoked_at IS NULL;

-- Refresh tokens: opaque, hashed at rest, single-use, chained into a family.
--
-- `family_id` is what makes theft detectable: rotation issues a new token in the same
-- family, and presenting an ALREADY-USED token means two parties hold the chain — so the
-- whole family is revoked rather than just that token (ADR-013).
CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id            uuid PRIMARY KEY,
  family_id     uuid        NOT NULL,
  session_id    uuid        NOT NULL REFERENCES auth.sessions (id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  token_hash    text        NOT NULL,     -- sha256 of the opaque token; the token itself is never stored
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz NULL,         -- set on rotation; a second use is the theft signal
  revoked_at    timestamptz NULL,
  replaced_by   uuid        NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_uq ON auth.refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON auth.refresh_tokens (family_id);
