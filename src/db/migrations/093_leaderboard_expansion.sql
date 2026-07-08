-- Leaderboard expansion: canonical model identity, ranking modes, roulette, and anti-spam metadata.

ALTER TABLE leaderboard_ratings ADD COLUMN canonical_model TEXT;
ALTER TABLE leaderboard_ratings ADD COLUMN raw_model TEXT;
ALTER TABLE leaderboard_ratings ADD COLUMN confidence_score REAL NOT NULL DEFAULT 0;
ALTER TABLE leaderboard_ratings ADD COLUMN official_rank INTEGER;

ALTER TABLE leaderboard_votes ADD COLUMN raw_model TEXT;
ALTER TABLE leaderboard_votes ADD COLUMN canonical_model TEXT;
ALTER TABLE leaderboard_votes ADD COLUMN ranking_mode TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE leaderboard_votes ADD COLUMN effect_weight REAL NOT NULL DEFAULT 1;
ALTER TABLE leaderboard_votes ADD COLUMN confidence REAL NOT NULL DEFAULT 1;
ALTER TABLE leaderboard_votes ADD COLUMN elo_delta INTEGER NOT NULL DEFAULT 0;

UPDATE leaderboard_ratings
SET canonical_model = lower(replace(replace(replace(trim(model), '-', ''), '_', ''), ' ', ''))
WHERE canonical_model IS NULL OR canonical_model = '';

UPDATE leaderboard_ratings
SET raw_model = model
WHERE raw_model IS NULL OR raw_model = '';

UPDATE leaderboard_votes
SET raw_model = model
WHERE raw_model IS NULL OR raw_model = '';

UPDATE leaderboard_votes
SET canonical_model = lower(replace(replace(replace(trim(model), '-', ''), '_', ''), ' ', ''))
WHERE canonical_model IS NULL OR canonical_model = '';

CREATE TABLE IF NOT EXISTS leaderboard_model_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider_scope TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  display_name TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, provider_scope, alias_key)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_alias_user ON leaderboard_model_aliases(user_id, provider_scope);
CREATE INDEX IF NOT EXISTS idx_leaderboard_ratings_canonical ON leaderboard_ratings(user_id, provider, canonical_model);
CREATE INDEX IF NOT EXISTS idx_leaderboard_votes_canonical ON leaderboard_votes(user_id, provider, canonical_model, created_at DESC);

CREATE TABLE IF NOT EXISTS leaderboard_roulette_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  left_model TEXT NOT NULL,
  left_provider TEXT NOT NULL,
  left_canonical_model TEXT NOT NULL,
  right_model TEXT NOT NULL,
  right_provider TEXT NOT NULL,
  right_canonical_model TEXT NOT NULL,
  winner TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  ranking_mode TEXT NOT NULL DEFAULT 'classic',
  left_elo_delta INTEGER NOT NULL DEFAULT 0,
  right_elo_delta INTEGER NOT NULL DEFAULT 0,
  connection_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_roulette_user_created
  ON leaderboard_roulette_votes(user_id, created_at DESC);
