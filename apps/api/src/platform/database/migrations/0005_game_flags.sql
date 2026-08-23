-- 0005_game_flags — per-game kill-switches (rule 16), P6.
--
-- Every game needs an explicit enable flag, and its safe default is OFF (see
-- flag-keys.ts): a game nobody has deliberately switched on is unavailable rather than
-- assumed playable. `coin-duel` is the engine's development fixture — enabled here so the
-- conformance and integration suites can run it; the shipped games arrive with P8/P9 and
-- get their own rows.
--
-- ROLLBACK: DELETE FROM platform.feature_flags WHERE key LIKE 'game.%';

INSERT INTO platform.feature_flags (key, value_bool, description, requires_four_eyes)
VALUES
  ('game.coin-duel.enabled', true,
   'Reference game used by the engine test suites. Never exposed in a lobby.',
   false)
ON CONFLICT (key) DO NOTHING;
