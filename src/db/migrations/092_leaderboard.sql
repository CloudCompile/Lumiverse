-- Leaderboard: Elo ratings for models based on user thumbs-up/down feedback.
-- Each row tracks a unique (user, model, provider) combo with its Elo score.
CREATE TABLE IF NOT EXISTS leaderboard_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_id TEXT,
  elo INTEGER NOT NULL DEFAULT 1500,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  total_votes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, model, provider)
);

-- Individual votes so users can undo / change their vote on a message.
CREATE TABLE IF NOT EXISTS leaderboard_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  swipe_id INTEGER NOT NULL DEFAULT 0,
  chat_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_id TEXT,
  vote INTEGER NOT NULL, -- 1 = thumbs up, -1 = thumbs down
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, message_id, swipe_id)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_ratings_user ON leaderboard_ratings(user_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_ratings_elo ON leaderboard_ratings(user_id, elo DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_votes_message ON leaderboard_votes(user_id, message_id, swipe_id);
