-- 0007_crash — P8 Crash, the first shipped game (ADR-023, ADR-024).
-- See docs/02-domains/crash-game-rules.md and docs/phases/PHASE-08-casino-game-crash.md.
--
-- ROLLBACK:
--   DELETE FROM game.stake_tiers WHERE game_code = 'crash';
--   DELETE FROM platform.feature_flags WHERE key = 'game.crash.enabled';
--   ALTER TABLE game.stake_tiers  DROP COLUMN IF EXISTS config;
--   ALTER TABLE game.match_players DROP COLUMN IF EXISTS meta;
-- Both columns carry defaults and both tables are small, so the forward migration takes
-- no meaningful lock and needs no backfill.

-- Per-player data decided at join time, before `init` runs — so it belongs to the roster
-- rather than to game state. Crash stores an auto-cash-out target here; poker (P9) will
-- store sit-out state. Replayed with the roster, which is what keeps it deterministic.
ALTER TABLE game.match_players
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Per-tier game configuration. Bet bounds, exposure caps, round timings and the house
-- edge are configuration rather than constants: they differ per tier today and will
-- differ per jurisdiction later (rule 11's "jurisdiction-dependent values are config").
ALTER TABLE game.stake_tiers
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Crash tiers. `stake` is the tier's reference bet (what the lobby shows); the actual bet
-- is chosen per round within [betMin, betMax].
--
-- maxHouseExposure is the worst case the house accepts on one round: every rider cashing
-- out at the cap. It is large relative to the stakes precisely because the cap is 100× —
-- stating it honestly is the point of the number. These are TST values; real-currency
-- configuration is a P18 concern and will not be these.
INSERT INTO game.stake_tiers (id, game_code, name, stake, sort_order, config) VALUES
  ('crash:free',  'crash', 'Free play', 0, 0, '{
     "betMin": 0, "betMax": 0,
     "maxRoundStake": 0, "maxHouseExposure": 0,
     "bettingWindowMs": 7000, "interRoundMs": 5000,
     "houseEdgeBps": 300, "maxMultiplierX100": 10000
   }'::jsonb),
  ('crash:micro', 'crash', 'Micro', 1000, 1, '{
     "betMin": 1000, "betMax": 25000,
     "maxRoundStake": 200000, "maxHouseExposure": 20000000,
     "bettingWindowMs": 7000, "interRoundMs": 5000,
     "houseEdgeBps": 300, "maxMultiplierX100": 10000
   }'::jsonb),
  ('crash:low',   'crash', 'Low', 5000, 2, '{
     "betMin": 5000, "betMax": 100000,
     "maxRoundStake": 500000, "maxHouseExposure": 50000000,
     "bettingWindowMs": 7000, "interRoundMs": 5000,
     "houseEdgeBps": 300, "maxMultiplierX100": 10000
   }'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- The per-game kill-switch (rule 16). ON because this is a TST game and the whole
-- platform still sits behind `compliance.real_money_enabled`; turning it OFF drains the
-- in-flight round and opens no further ones.
INSERT INTO platform.feature_flags (key, value_bool, description, requires_four_eyes)
VALUES
  ('game.crash.enabled', true,
   'Crash (P8). OFF drains the current round and stops new ones opening.',
   false)
ON CONFLICT (key) DO NOTHING;
