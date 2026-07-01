import { getDb } from "../db/connection";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  model: string;
  provider: string;
  connection_id: string | null;
  elo: number;
  wins: number;
  losses: number;
  total_votes: number;
}

export interface LeaderboardVote {
  id: number;
  message_id: string;
  swipe_id: number;
  chat_id: string;
  model: string;
  provider: string;
  vote: number;
  created_at: number;
}

// ── Elo helpers ────────────────────────────────────────────────────────────

const K_FACTOR = 32;
const DEFAULT_ELO = 1500;

/**
 * Simplified Elo update for a single model against the field average.
 * A thumbs-up is treated as a "win" vs the average opponent (1500),
 * a thumbs-down as a "loss".
 */
function computeNewElo(
  currentElo: number,
  outcome: 1 | -1,
): number {
  const expected = 1 / (1 + Math.pow(10, (DEFAULT_ELO - currentElo) / 400));
  const actual = outcome === 1 ? 1 : 0;
  return Math.round(currentElo + K_FACTOR * (actual - expected));
}

// ── Service ────────────────────────────────────────────────────────────────

export function getLeaderboard(userId: string): LeaderboardEntry[] {
  const db = getDb();
  return db
    .query(
      `SELECT model, provider, connection_id, elo, wins, losses, total_votes
       FROM leaderboard_ratings
       WHERE user_id = ?
       ORDER BY elo DESC, total_votes DESC`,
    )
    .all(userId) as LeaderboardEntry[];
}

export function getVoteForMessage(
  userId: string,
  messageId: string,
  swipeId: number,
): LeaderboardVote | null {
  const db = getDb();
  return (
    (db
      .query(
        `SELECT id, message_id, swipe_id, chat_id, model, provider, vote, created_at
         FROM leaderboard_votes
         WHERE user_id = ? AND message_id = ? AND swipe_id = ?`,
      )
      .get(userId, messageId, swipeId) as LeaderboardVote | null) ?? null
  );
}

export function getVotesForChat(
  userId: string,
  chatId: string,
): LeaderboardVote[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, message_id, swipe_id, chat_id, model, provider, vote, created_at
       FROM leaderboard_votes
       WHERE user_id = ? AND chat_id = ?`,
    )
    .all(userId, chatId) as LeaderboardVote[];
}

interface CastVoteInput {
  messageId: string;
  swipeId: number;
  chatId: string;
  model: string;
  provider: string;
  connectionId?: string | null;
  vote: 1 | -1;
}

/**
 * Record a vote on a message/swipe. If the user already voted on this
 * swipe, the old vote is reversed from the Elo before applying the new one.
 */
export function castVote(userId: string, input: CastVoteInput): LeaderboardEntry {
  const db = getDb();
  const { messageId, swipeId, chatId, model, provider, connectionId, vote } = input;

  const existing = db
    .query(
      `SELECT id, vote FROM leaderboard_votes
       WHERE user_id = ? AND message_id = ? AND swipe_id = ?`,
    )
    .get(userId, messageId, swipeId) as { id: number; vote: number } | null;

  // Get or create the rating row
  let rating = db
    .query(
      `SELECT elo, wins, losses, total_votes FROM leaderboard_ratings
       WHERE user_id = ? AND model = ? AND provider = ?`,
    )
    .get(userId, model, provider) as
    | { elo: number; wins: number; losses: number; total_votes: number }
    | null;

  if (!rating) {
    db.run(
      `INSERT INTO leaderboard_ratings (user_id, model, provider, connection_id, elo)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, model, provider, connectionId ?? null, DEFAULT_ELO],
    );
    rating = { elo: DEFAULT_ELO, wins: 0, losses: 0, total_votes: 0 };
  }

  let { elo, wins, losses, total_votes } = rating;

  // Reverse old vote if changing
  if (existing) {
    const oldVote = existing.vote as 1 | -1;
    if (oldVote === vote) {
      // Same vote — return current state
      return { model, provider, connection_id: connectionId ?? null, elo, wins, losses, total_votes };
    }
    // Reverse old vote's Elo effect
    elo = computeNewElo(elo, oldVote === 1 ? -1 : 1);
    if (oldVote === 1) wins = Math.max(0, wins - 1);
    else losses = Math.max(0, losses - 1);
    total_votes = Math.max(0, total_votes - 1);
  }

  // Apply new vote
  elo = computeNewElo(elo, vote);
  if (vote === 1) wins++;
  else losses++;
  total_votes++;

  // Upsert vote row
  if (existing) {
    db.run(
      `UPDATE leaderboard_votes SET vote = ?, model = ?, provider = ?, connection_id = ?, created_at = unixepoch()
       WHERE id = ?`,
      [vote, model, provider, connectionId ?? null, existing.id],
    );
  } else {
    db.run(
      `INSERT INTO leaderboard_votes (user_id, message_id, swipe_id, chat_id, model, provider, connection_id, vote)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, messageId, swipeId, chatId, model, provider, connectionId ?? null, vote],
    );
  }

  // Update rating
  db.run(
    `UPDATE leaderboard_ratings SET elo = ?, wins = ?, losses = ?, total_votes = ?, connection_id = COALESCE(?, connection_id), updated_at = unixepoch()
     WHERE user_id = ? AND model = ? AND provider = ?`,
    [elo, wins, losses, total_votes, connectionId ?? null, userId, model, provider],
  );

  return { model, provider, connection_id: connectionId ?? null, elo, wins, losses, total_votes };
}

/**
 * Remove a vote on a message/swipe and reverse its Elo effect.
 */
export function removeVote(
  userId: string,
  messageId: string,
  swipeId: number,
): boolean {
  const db = getDb();

  const existing = db
    .query(
      `SELECT id, vote, model, provider FROM leaderboard_votes
       WHERE user_id = ? AND message_id = ? AND swipe_id = ?`,
    )
    .get(userId, messageId, swipeId) as
    | { id: number; vote: number; model: string; provider: string }
    | null;

  if (!existing) return false;

  const rating = db
    .query(
      `SELECT elo, wins, losses, total_votes FROM leaderboard_ratings
       WHERE user_id = ? AND model = ? AND provider = ?`,
    )
    .get(userId, existing.model, existing.provider) as
    | { elo: number; wins: number; losses: number; total_votes: number }
    | null;

  if (rating) {
    const oldVote = existing.vote as 1 | -1;
    const elo = computeNewElo(rating.elo, oldVote === 1 ? -1 : 1);
    const wins = oldVote === 1 ? Math.max(0, rating.wins - 1) : rating.wins;
    const losses = oldVote === -1 ? Math.max(0, rating.losses - 1) : rating.losses;
    const total_votes = Math.max(0, rating.total_votes - 1);

    db.run(
      `UPDATE leaderboard_ratings SET elo = ?, wins = ?, losses = ?, total_votes = ?, updated_at = unixepoch()
       WHERE user_id = ? AND model = ? AND provider = ?`,
      [elo, wins, losses, total_votes, userId, existing.model, existing.provider],
    );
  }

  db.run(`DELETE FROM leaderboard_votes WHERE id = ?`, [existing.id]);
  return true;
}

/**
 * Reset all leaderboard data for a user.
 */
export function resetLeaderboard(userId: string): void {
  const db = getDb();
  db.run(`DELETE FROM leaderboard_votes WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM leaderboard_ratings WHERE user_id = ?`, [userId]);
}
