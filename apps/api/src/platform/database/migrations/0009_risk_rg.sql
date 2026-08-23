-- 0009_risk_rg — P10 risk engine and responsible gaming (ADR-018, ADR-026).
-- See docs/02-domains/fraud-risk.md and docs/02-domains/responsible-gaming.md.
--
-- ROLLBACK:
--   DROP SCHEMA IF EXISTS risk CASCADE;
--   DROP SCHEMA IF EXISTS rg CASCADE;

CREATE SCHEMA IF NOT EXISTS rg;
CREATE SCHEMA IF NOT EXISTS risk;

-- ===========================================================================
-- Responsible gaming
-- ===========================================================================

-- A player's limits. Both origins live here: what the player chose, and what a
-- jurisdiction mandates (P15/P18). A player may always set stricter than a mandate and
-- never looser — enforced in the service, because "strictest wins" is a comparison the
-- database cannot make across rows.
CREATE TABLE IF NOT EXISTS rg.limits (
  id            uuid PRIMARY KEY,
  user_id       uuid    NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  type          text    NOT NULL CHECK (type IN ('deposit', 'loss', 'wager', 'session_time')),
  period        text    NOT NULL CHECK (period IN ('day', 'week', 'month')),
  -- Minor units for money limits; minutes for session_time.
  amount        bigint  NOT NULL CHECK (amount >= 0),
  origin        text    NOT NULL DEFAULT 'player'
                CHECK (origin IN ('player', 'jurisdiction')),
  -- An increase does not take effect until its cooling period elapses; a decrease is
  -- immediate. `pending_amount` holds the requested looser value meanwhile, so the player
  -- can see it and cancel it.
  pending_amount    bigint NULL CHECK (pending_amount IS NULL OR pending_amount >= 0),
  pending_effective_at timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, period, origin)
);
CREATE INDEX IF NOT EXISTS rg_limits_user_idx ON rg.limits (user_id);

-- Rolling consumption. A cache of something derivable from the ledger, kept because the
-- check runs inside every spend and cannot afford to aggregate the ledger each time —
-- reconciled by the same discipline as `wallet.balances` (rule 9).
CREATE TABLE IF NOT EXISTS rg.limit_usage (
  user_id      uuid    NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  type         text    NOT NULL CHECK (type IN ('deposit', 'loss', 'wager', 'session_time')),
  period       text    NOT NULL CHECK (period IN ('day', 'week', 'month')),
  -- Start of the window this row meters. A new window is a new row rather than a reset,
  -- so history survives and a bug cannot erase evidence.
  window_start timestamptz NOT NULL,
  -- What went out (stakes, faucet credits, minutes) and what came back (winnings), so a
  -- loss limit is a subtraction rather than a second counter that can disagree.
  spent        bigint  NOT NULL DEFAULT 0 CHECK (spent >= 0),
  returned     bigint  NOT NULL DEFAULT 0 CHECK (returned >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type, period, window_start)
);

-- Cool-off and self-exclusion. Never deleted, never shortened.
CREATE TABLE IF NOT EXISTS rg.exclusions (
  id         uuid PRIMARY KEY,
  user_id    uuid    NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  kind       text    NOT NULL CHECK (kind IN ('cool_off', 'self_exclusion')),
  source     text    NOT NULL DEFAULT 'player' CHECK (source IN ('player', 'admin', 'regulator')),
  starts_at  timestamptz NOT NULL DEFAULT now(),
  -- NULL means permanent. There is no path that sets this to a nearer time.
  ends_at    timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rg_exclusions_user_idx ON rg.exclusions (user_id, starts_at DESC);

-- Shortening or deleting an exclusion is the one thing this table must never allow — not
-- by an admin, not by a superadmin, not by a support script at 3am. Extending is fine.
CREATE OR REPLACE FUNCTION rg.protect_exclusions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rg.exclusions cannot be deleted — an exclusion expires, it is not removed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.ends_at IS NULL AND NEW.ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'a permanent exclusion cannot be given an end date'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.ends_at IS NOT NULL AND OLD.ends_at IS NOT NULL AND NEW.ends_at < OLD.ends_at THEN
    RAISE EXCEPTION 'an exclusion cannot be shortened (% -> %)', OLD.ends_at, NEW.ends_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rg_exclusions_protected ON rg.exclusions;
CREATE TRIGGER rg_exclusions_protected
  BEFORE UPDATE OR DELETE ON rg.exclusions
  FOR EACH ROW EXECUTE FUNCTION rg.protect_exclusions();

CREATE TABLE IF NOT EXISTS rg.reality_check_prefs (
  user_id       uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE RESTRICT,
  interval_ms   bigint NOT NULL DEFAULT 1800000 CHECK (interval_ms >= 60000),
  last_shown_at timestamptz NULL,
  last_ack_at   timestamptz NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The player-visible history, and the compliance evidence trail. Distinct from the audit
-- log: the audit log records that a mutation happened, this records what the player
-- experienced.
CREATE TABLE IF NOT EXISTS rg.events (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rg_events_user_idx ON rg.events (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION rg.reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rg.events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS rg_events_no_mutation ON rg.events;
CREATE TRIGGER rg_events_no_mutation
  BEFORE UPDATE OR DELETE ON rg.events
  FOR EACH ROW EXECUTE FUNCTION rg.reject_event_mutation();

-- ===========================================================================
-- Risk
-- ===========================================================================

-- Rules assign meaning to signals. Emitters report facts and never their own weight —
-- otherwise a compromised client could tell the server how much to care about what it says.
CREATE TABLE IF NOT EXISTS risk.rules (
  type          text PRIMARY KEY,
  weight        integer NOT NULL,
  ttl_seconds   integer NOT NULL CHECK (ttl_seconds > 0),
  -- Evidence that exists only because a client said so. Normative: these may raise a score
  -- and trigger flag/limit, and may NEVER on their own freeze an account
  -- (`fraud-risk.md §6`). Enforced in code; recorded here so a rule edit cannot quietly
  -- reclassify a client signal as server evidence.
  client_only   boolean NOT NULL DEFAULT false,
  description   text    NOT NULL DEFAULT '',
  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk.signals (
  id            uuid PRIMARY KEY,
  user_id       uuid NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  session_id    uuid NULL,
  device_id     text NULL,
  match_id      uuid NULL,
  source        text NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The weight in force when this was ingested. Kept so a later rule change cannot
  -- retroactively alter what an action was based on — a case must be defensible against
  -- the rules as they stood.
  weight_at_ingest integer NOT NULL,
  client_only   boolean NOT NULL DEFAULT false,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_signals_user_idx ON risk.signals (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS risk_signals_type_idx ON risk.signals (type, created_at DESC);

CREATE OR REPLACE FUNCTION risk.reject_signal_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'risk.signals is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS risk_signals_no_mutation ON risk.signals;
CREATE TRIGGER risk_signals_no_mutation
  BEFORE UPDATE OR DELETE ON risk.signals
  FOR EACH ROW EXECUTE FUNCTION risk.reject_signal_mutation();

CREATE TABLE IF NOT EXISTS risk.actions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  action     text NOT NULL CHECK (action IN ('flag', 'limit', 'require_review', 'freeze')),
  reason     text NOT NULL,
  -- The score and the signals it rested on, frozen at the moment of the decision.
  evidence   jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_by text NOT NULL DEFAULT 'system',
  applied_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  lifted_at  timestamptz NULL,
  lifted_by  text NULL
);
CREATE INDEX IF NOT EXISTS risk_actions_user_idx ON risk.actions (user_id, applied_at DESC);

-- Every freeze creates one of these. There is no freeze without a review path.
CREATE TABLE IF NOT EXISTS risk.cases (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  state       text NOT NULL DEFAULT 'open'
              CHECK (state IN ('open', 'in_review', 'pending_info', 'resolved')),
  resolution  text NULL CHECK (resolution IN ('cleared', 'actioned', 'escalated')),
  priority    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  reason      text NOT NULL,
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  assignee    text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS risk_cases_state_idx ON risk.cases (state, created_at);

-- Identity graph. Edges accumulate; the weight of a shared device is how many *distinct*
-- accounts sit on it and how recently.
CREATE TABLE IF NOT EXISTS risk.device_links (
  device_id  text NOT NULL,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  hits       integer NOT NULL DEFAULT 1,
  PRIMARY KEY (device_id, user_id)
);
CREATE INDEX IF NOT EXISTS risk_device_links_user_idx ON risk.device_links (user_id);

CREATE TABLE IF NOT EXISTS risk.ip_links (
  ip         text NOT NULL,
  user_id    uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  hits       integer NOT NULL DEFAULT 1,
  PRIMARY KEY (ip, user_id)
);
CREATE INDEX IF NOT EXISTS risk_ip_links_user_idx ON risk.ip_links (user_id);

-- ---------------------------------------------------------------------------
-- Default rules.
--
-- Weights are deliberately modest for client-only evidence and heavy for things the server
-- observed itself. The freeze threshold (see risk.config.ts) is above what any combination
-- of client-only signals can reach — that is the normative rule made arithmetic rather
-- than aspirational.
-- ---------------------------------------------------------------------------
INSERT INTO risk.rules (type, weight, ttl_seconds, client_only, description) VALUES
  ('client.root_detected',        15, 604800, true,  'Device reports root access'),
  ('client.emulator_detected',    10, 604800, true,  'Device reports running under an emulator'),
  ('client.hook_detected',        25, 604800, true,  'Device reports an instrumentation framework'),
  ('client.signature_mismatch',   30, 604800, true,  'APK signature self-check failed'),
  ('client.integrity_failed',     20, 604800, true,  'Play Integrity verdict below device integrity (OQ-12)'),
  ('identity.device_shared',      20, 2592000, false, 'One device seen on several accounts'),
  ('identity.ip_shared',           8, 2592000, false, 'One address seen on many accounts (NAT-dampened)'),
  ('velocity.faucet_burst',       25, 86400,  false, 'Funding claimed unusually fast'),
  ('gameplay.chip_dump',          40, 2592000, false, 'One-sided chip transfer between players'),
  -- The same finding, corroborated by the identity graph. A dump between two strangers is
  -- suspicious; a dump between two accounts that have shared a device is most of a case,
  -- and a separate rule says so explicitly rather than hiding a multiplier in code.
  ('gameplay.chip_dump_linked',   70, 2592000, false, 'One-sided chip transfer between linked accounts'),
  ('gameplay.collusion_coseating', 20, 2592000, false, 'Two players seated together far above chance'),
  -- Weight zero: a fact, not a judgement. Hand summaries are retained so the collusion
  -- heuristics have history to aggregate over, and contribute nothing to a score by
  -- themselves — playing poker is not evidence of anything.
  ('gameplay.hand_summary',        0, 2592000, false, 'Per-hand chip movement, kept for aggregation'),
  ('protocol.invalid_action_burst', 15, 86400, false, 'Repeated illegal actions from one client')
ON CONFLICT (type) DO NOTHING;
