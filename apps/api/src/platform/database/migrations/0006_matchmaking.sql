-- 0006_matchmaking — P7 matchmaking & lobby.
-- See docs/02-domains/matchmaking.md.
-- ROLLBACK: DROP TABLE IF EXISTS game.formations; DROP TABLE IF EXISTS game.stake_tiers;

-- Stake tiers per game. Configuration rather than constants so tiers can be tuned (and,
-- later, differ per jurisdiction) without a deploy.
CREATE TABLE IF NOT EXISTS game.stake_tiers (
  id          text PRIMARY KEY,              -- e.g. 'coin-duel:micro'
  game_code   text    NOT NULL,
  name        text    NOT NULL,
  stake       bigint  NOT NULL CHECK (stake >= 0),
  currency    char(3) NOT NULL DEFAULT 'TST',
  enabled     boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stake_tiers_game_idx ON game.stake_tiers (game_code, sort_order);

-- An audit trail of formations. The live queue is Redis (ephemeral, rule 7); this records
-- what was actually formed, so a disputed "I was charged but never played" has an answer
-- independent of the queue that has since expired.
CREATE TABLE IF NOT EXISTS game.formations (
  id          uuid PRIMARY KEY,
  match_id    uuid    NULL REFERENCES game.matches (id) ON DELETE SET NULL,
  game_code   text    NOT NULL,
  tier_id     text    NOT NULL,
  user_ids    uuid[]  NOT NULL,
  outcome     text    NOT NULL CHECK (outcome IN ('formed', 'failed')),
  reason      text    NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS formations_created_idx ON game.formations (created_at DESC);

-- Tiers for the reference game, so the lobby and its tests have something to show.
-- The shipped games bring their own in P8/P9.
INSERT INTO game.stake_tiers (id, game_code, name, stake, sort_order) VALUES
  ('coin-duel:free',  'coin-duel', 'Free play', 0,    0),
  ('coin-duel:micro', 'coin-duel', 'Micro',     1000, 1),
  ('coin-duel:low',   'coin-duel', 'Low',       5000, 2)
ON CONFLICT (id) DO NOTHING;
