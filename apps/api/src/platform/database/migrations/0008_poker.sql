-- 0008_poker — P9 No-Limit Hold'em cash tables (ADR-025, OQ-07).
-- See docs/02-domains/poker.md and docs/phases/PHASE-09-poker.md.
--
-- ROLLBACK:
--   DROP SCHEMA IF EXISTS poker CASCADE;
--   DELETE FROM game.stake_tiers WHERE game_code = 'poker';
--   DELETE FROM platform.feature_flags WHERE key = 'game.poker.enabled';
--   ALTER TABLE wallet.accounts DROP COLUMN IF EXISTS table_id;
--   (the account-type CHECK would need restoring to its 0003 form)

-- ---------------------------------------------------------------------------
-- Table-scoped escrow (ADR-025).
--
-- Poker stacks persist across hands, so the escrow holding them belongs to the *table*
-- rather than to any one match. Money enters when a player sits down and leaves when they
-- stand up; the hands in between move nothing but rake.
-- ---------------------------------------------------------------------------
ALTER TABLE wallet.accounts ADD COLUMN IF NOT EXISTS table_id uuid NULL;

ALTER TABLE wallet.accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE wallet.accounts ADD CONSTRAINT accounts_type_check CHECK (type IN
  ('user_wallet', 'house_main', 'house_dev_funding', 'rake', 'bonus',
   'match_escrow', 'table_escrow'));

CREATE UNIQUE INDEX IF NOT EXISTS accounts_table_currency_uq
  ON wallet.accounts (table_id, currency) WHERE table_id IS NOT NULL;

-- The house singleton index keys on (type, currency) where user and match are null. A
-- table escrow has a table_id, so it is excluded by that predicate already — but make the
-- exclusion explicit rather than incidental.
DROP INDEX IF EXISTS wallet.accounts_house_uq;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_house_uq
  ON wallet.accounts (type, currency)
  WHERE user_id IS NULL AND match_id IS NULL AND table_id IS NULL;

CREATE SCHEMA IF NOT EXISTS poker;

-- ---------------------------------------------------------------------------
-- tables — a long-lived cash game. Hands come and go; the table stays.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poker.tables (
  id          uuid PRIMARY KEY,
  tier_id     text        NOT NULL REFERENCES game.stake_tiers (id),
  name        text        NOT NULL,
  seat_count  integer     NOT NULL CHECK (seat_count BETWEEN 2 AND 6),
  currency    char(3)     NOT NULL DEFAULT 'TST',
  config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status      text        NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'closing', 'closed')),
  -- Rotates every hand; the seat holding it is derived from this and the seat order.
  button_seat integer     NOT NULL DEFAULT 0,
  hand_no     integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tables_tier_idx ON poker.tables (tier_id, status);

-- ---------------------------------------------------------------------------
-- seats — who is sitting where, and with how many chips.
--
-- `stack` is a **cache**: during a hand the truth is the hand's event log, and this row is
-- updated when the hand settles. It exists so a player can be seated, and the table dealt,
-- without replaying every hand ever played there.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poker.seats (
  table_id        uuid    NOT NULL REFERENCES poker.tables (id) ON DELETE CASCADE,
  seat_no         integer NOT NULL,
  user_id         uuid    NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  -- One sitting. Every ledger movement for this seat is idempotent on it, so a retried
  -- sit-down or stand-up cannot double-charge or double-pay.
  seat_session_id uuid    NOT NULL,
  stack           bigint  NOT NULL CHECK (stack >= 0),
  state           text    NOT NULL DEFAULT 'seated'
                  CHECK (state IN ('seated', 'sitting_out', 'standing')),
  sat_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, seat_no)
);

-- A player holds at most one seat per table: two seats would be collusion with yourself
-- (`poker.md §13`), and it is cheaper to make impossible than to detect.
CREATE UNIQUE INDEX IF NOT EXISTS seats_one_per_user_uq
  ON poker.seats (table_id, user_id);
CREATE INDEX IF NOT EXISTS seats_user_idx ON poker.seats (user_id);

-- ---------------------------------------------------------------------------
-- hands — the public record of a hand. Hole cards and deck order are NOT here:
-- they live in game.game_events, which is append-only and hash-verifiable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poker.hands (
  match_id    uuid PRIMARY KEY REFERENCES game.matches (id) ON DELETE CASCADE,
  table_id    uuid    NOT NULL REFERENCES poker.tables (id) ON DELETE CASCADE,
  hand_no     integer NOT NULL,
  button_seat integer NOT NULL,
  pot         bigint  NOT NULL DEFAULT 0,
  rake        bigint  NOT NULL DEFAULT 0,
  board       text[]  NOT NULL DEFAULT '{}',
  -- Public showdown summary only: who showed what, and who won. Never a mucked hand.
  summary     jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, hand_no)
);
CREATE INDEX IF NOT EXISTS hands_table_idx ON poker.hands (table_id, hand_no DESC);

-- ---------------------------------------------------------------------------
-- Stake tiers and the kill-switch.
--
-- Blinds are the tier's stake; buy-in bounds are big-blind multiples per `poker.md §2`.
-- **Rake is zero on TST** — the mechanism is built and exercised from day one, but a test
-- economy has nothing to rake and charging it would teach us nothing (`poker.md §5`).
-- ---------------------------------------------------------------------------
INSERT INTO game.stake_tiers (id, game_code, name, stake, sort_order, config) VALUES
  ('poker:micro', 'poker', 'Micro 1/2', 200, 10, '{
     "blinds": {"sb": 100, "bb": 200},
     "buyIn": {"min": 8000, "max": 20000},
     "turnTimerMs": 15000,
     "timebankMs": 30000,
     "timebankStepMs": 10000,
     "rake": {"bps": 0, "cap": 0},
     "buttonOrder": 0,
     "muckLosers": true,
     "seats": 6
   }'::jsonb),
  ('poker:low', 'poker', 'Low 5/10', 1000, 11, '{
     "blinds": {"sb": 500, "bb": 1000},
     "buyIn": {"min": 40000, "max": 100000},
     "turnTimerMs": 15000,
     "timebankMs": 30000,
     "timebankStepMs": 10000,
     "rake": {"bps": 0, "cap": 0},
     "buttonOrder": 0,
     "muckLosers": true,
     "seats": 6
   }'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform.feature_flags (key, value_bool, description, requires_four_eyes)
VALUES
  ('game.poker.enabled', true,
   'No-Limit Hold''em cash tables (P9). OFF finishes the hand in progress and deals no more.',
   false)
ON CONFLICT (key) DO NOTHING;
