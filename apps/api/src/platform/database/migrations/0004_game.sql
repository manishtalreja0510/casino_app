-- 0004_game — P6 game engine (ADR-006, ADR-009).
-- See docs/01-architecture/game-architecture.md.
-- ROLLBACK: DROP SCHEMA IF EXISTS game CASCADE;   (only while no production data exists)

CREATE SCHEMA IF NOT EXISTS game;

CREATE TABLE IF NOT EXISTS game.matches (
  id            uuid PRIMARY KEY,
  game_code     text        NOT NULL,
  -- The rules version this match started on. A match in flight finishes on the version it
  -- began with; deploying new rules must never change a game already being played.
  game_version  integer     NOT NULL,
  status        text        NOT NULL DEFAULT 'created'
                CHECK (status IN ('created','starting','in_progress','settling','settled','voided')),
  stake         bigint      NOT NULL DEFAULT 0,
  currency      char(3)     NOT NULL DEFAULT 'TST',
  config        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  void_reason   text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz NULL,
  ended_at      timestamptz NULL
);
CREATE INDEX IF NOT EXISTS matches_status_idx ON game.matches (status, created_at);
CREATE INDEX IF NOT EXISTS matches_game_idx ON game.matches (game_code, created_at);

CREATE TABLE IF NOT EXISTS game.match_players (
  match_id   uuid    NOT NULL REFERENCES game.matches (id) ON DELETE CASCADE,
  user_id    uuid    NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  seat       integer NOT NULL,
  stake      bigint  NOT NULL DEFAULT 0,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id),
  UNIQUE (match_id, seat)
);

-- The authoritative history of a match. PostgreSQL is the record; Redis is only a cache
-- of current state (rule 7). Recovery and dispute resolution both read from here.
CREATE TABLE IF NOT EXISTS game.game_events (
  id          uuid PRIMARY KEY,
  match_id    uuid    NOT NULL REFERENCES game.matches (id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text    NOT NULL,
  -- The action or timeout that produced this event, and the RNG draws it consumed.
  -- Recording draws is what makes replay deterministic and a disputed outcome checkable.
  payload     jsonb   NOT NULL DEFAULT '{}'::jsonb,
  actor_id    uuid    NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, seq)
);
CREATE INDEX IF NOT EXISTS game_events_match_idx ON game.game_events (match_id, seq);

-- Periodic snapshots bound replay cost. A snapshot is an optimisation: it must always be
-- reconstructible from the events, never the only copy of anything.
CREATE TABLE IF NOT EXISTS game.game_snapshots (
  match_id    uuid    NOT NULL REFERENCES game.matches (id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  state       jsonb   NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);

-- Append-only, same as the ledger and audit log: a match's history is evidence.
CREATE OR REPLACE FUNCTION game.reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'game.game_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS game_events_no_mutation ON game.game_events;
CREATE TRIGGER game_events_no_mutation
  BEFORE UPDATE OR DELETE ON game.game_events
  FOR EACH ROW EXECUTE FUNCTION game.reject_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON game.game_events FROM PUBLIC;
