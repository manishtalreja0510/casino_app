-- 0001_platform_audit — P1 backend platform core.
--
-- Creates the `platform` (feature flags / kill-switches) and `audit` (immutable
-- hash-chained audit log) schemas. See docs/01-architecture/database-architecture.md §2, §6.
--
-- ROLLBACK: DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA IF EXISTS platform CASCADE;
--           (safe while no production data exists; after that, never — rule 5 applies to audit too.)

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------------------
-- platform.feature_flags — truth for flags and kill-switches (rule 16).
-- Redis caches these; the database is authoritative. Safe defaults are OFF.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.feature_flags (
  key                 text PRIMARY KEY,
  value_bool          boolean     NOT NULL,
  description         text        NOT NULL DEFAULT '',
  -- Flags whose change requires two distinct approvers (rule 11). Enforcement UI is P12;
  -- the field exists now so the constraint is never retrofitted onto live flags.
  requires_four_eyes  boolean     NOT NULL DEFAULT false,
  updated_by          text        NOT NULL DEFAULT 'system',
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The two mandatory flags. Both OFF: real money stays gated (rule 11), and the
-- platform starts serving rather than in maintenance.
INSERT INTO platform.feature_flags (key, value_bool, description, requires_four_eyes)
VALUES
  ('compliance.real_money_enabled', false,
   'Master compliance gate. Real-money paths are unreachable while false (rule 11). Four-eyes to change.',
   true),
  ('platform.maintenance_mode', false,
   'Global kill-switch. When true the API returns 503 MAINTENANCE except for health probes (rule 16).',
   false)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- audit.audit_log — append-only, hash-chained (rule 15).
-- `payload` carries opaque ids only: no PII, no secrets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.audit_log (
  id          uuid PRIMARY KEY,                     -- UUIDv7
  seq         bigint GENERATED ALWAYS AS IDENTITY,  -- global chain order
  actor_type  text        NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_id    uuid        NULL,
  action      text        NOT NULL,                 -- e.g. wallet.reversal, flags.change
  subject_ref text        NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   bytea       NOT NULL,
  hash        bytea       NOT NULL,                 -- H(prev_hash || canonical(row))
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_seq_uq ON audit.audit_log (seq);
CREATE INDEX IF NOT EXISTS audit_log_actor_created_idx ON audit.audit_log (actor_id, created_at);
CREATE INDEX IF NOT EXISTS audit_log_action_created_idx ON audit.audit_log (action, created_at);

-- Layer 1 of append-only enforcement: a trigger that refuses mutation for EVERY role,
-- including superusers and anyone with a psql prompt. Corrections are new rows, never edits.
CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_log is append-only: % is not permitted (rule 15)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_mutation ON audit.audit_log;
CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

-- Layer 2: revoke the privileges outright from the application role, so the trigger is
-- a backstop rather than the only defence. (Granting happens in deployment provisioning;
-- REVOKE is idempotent and harmless when the grant was never made.)
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_log FROM PUBLIC;
