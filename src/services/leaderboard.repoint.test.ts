import { beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as svc from "./leaderboard.service";

function setup() {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    user_id TEXT, PRIMARY KEY (key, user_id))`);
  db.run(`CREATE TABLE leaderboard_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
    connection_id TEXT, elo INTEGER NOT NULL DEFAULT 1500, wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0, total_votes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()), canonical_model TEXT, raw_model TEXT,
    confidence_score REAL NOT NULL DEFAULT 0, official_rank INTEGER, UNIQUE(user_id, model, provider))`);
  db.run(`CREATE TABLE leaderboard_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, message_id TEXT NOT NULL,
    swipe_id INTEGER NOT NULL DEFAULT 0, chat_id TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
    connection_id TEXT, vote INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    raw_model TEXT, canonical_model TEXT, ranking_mode TEXT NOT NULL DEFAULT 'classic',
    effect_weight REAL NOT NULL DEFAULT 1, confidence REAL NOT NULL DEFAULT 1, elo_delta INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, message_id, swipe_id))`);
  db.run(`CREATE TABLE leaderboard_model_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, provider_scope TEXT NOT NULL,
    alias_key TEXT NOT NULL, canonical_key TEXT NOT NULL, display_name TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(user_id, provider_scope, alias_key))`);
  db.run(`CREATE TABLE leaderboard_roulette_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, left_model TEXT NOT NULL,
    left_provider TEXT NOT NULL, left_canonical_model TEXT NOT NULL, right_model TEXT NOT NULL,
    right_provider TEXT NOT NULL, right_canonical_model TEXT NOT NULL, winner TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1, ranking_mode TEXT NOT NULL DEFAULT 'classic',
    left_elo_delta INTEGER NOT NULL DEFAULT 0, right_elo_delta INTEGER NOT NULL DEFAULT 0,
    connection_id TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  return db;
}

describe("leaderboard re-pointed vote accounting", () => {
  let db: ReturnType<typeof getDb>;
  const USER = "user-a";
  const getRating = (canonical: string) =>
    db
      .query(
        `SELECT elo, wins, losses, total_votes FROM leaderboard_ratings
         WHERE user_id = ? AND provider = 'p' AND canonical_model = ?`,
      )
      .get(USER, canonical) as { elo: number; wins: number; losses: number; total_votes: number } | null;

  beforeEach(() => {
    db = setup();
    svc.putLeaderboardSettings(USER, { duplicateDampingWindowSec: 30 });
  });

  test("changing a vote after an alias re-point unwinds the original rating", () => {
    // Vote on `alpha`, recorded against its own rating row.
    svc.castVote(USER, { messageId: "m1", swipeId: 0, chatId: "c1", model: "alpha", provider: "p", vote: 1 });
    const alphaDelta = (db
      .query(`SELECT elo_delta FROM leaderboard_votes WHERE user_id = ? AND message_id = 'm1'`)
      .get(USER) as { elo_delta: number }).elo_delta;
    expect(getRating("alpha")?.elo).toBe(1500 + alphaDelta);

    // An alias edit merges `alpha` into `beta`. The stored vote still points at
    // the original `alpha` rating row.
    svc.upsertAlias(USER, { providerScope: "p", alias: "alpha", canonical: "beta" });

    // Flipping the vote re-resolves to `beta`. This previously threw a UNIQUE
    // constraint error, and leaked the original delta when it did not.
    svc.castVote(USER, { messageId: "m1", swipeId: 0, chatId: "c1", model: "alpha", provider: "p", vote: -1 });

    const rows = db
      .query(`SELECT model, canonical_model, elo, total_votes FROM leaderboard_ratings WHERE user_id = ?`)
      .all(USER) as Array<{ model: string; canonical_model: string; elo: number; total_votes: number }>;

    // Exactly one rating row, now canonicalised to the merged model, holding a
    // single vote whose elo was unwound to the 1500 baseline before re-scoring.
    expect(rows.length).toBe(1);
    expect(rows[0].canonical_model).toBe("beta");
    expect(rows[0].total_votes).toBe(1);
    expect(rows[0].elo).toBeLessThan(1500);
  });

  test("reprocess merges rating rows after an alias update", () => {
    // Two distinct model ids that the user then declares equivalent.
    db.run(
      `INSERT INTO leaderboard_ratings (user_id, model, raw_model, canonical_model, provider, elo, wins, losses, total_votes)
       VALUES (?, 'gpt-4o', 'gpt-4o', 'gpt4o', 'p', 1600, 3, 1, 4)`,
      [USER],
    );
    db.run(
      `INSERT INTO leaderboard_ratings (user_id, model, raw_model, canonical_model, provider, elo, wins, losses, total_votes)
       VALUES (?, 'gpt-4o-2024', 'gpt-4o-2024', 'gpt4o2024', 'p', 1400, 1, 3, 4)`,
      [USER],
    );

    svc.upsertAlias(USER, { providerScope: "p", alias: "gpt4o2024", canonical: "gpt4o" });
    svc.reprocessLeaderboardModels(USER);

    const rows = db
      .query(`SELECT canonical_model, total_votes FROM leaderboard_ratings WHERE user_id = ?`)
      .all(USER) as Array<{ canonical_model: string; total_votes: number }>;

    // The two rows must collapse into one canonical group with the votes summed.
    expect(rows.length).toBe(1);
    expect(rows[0].canonical_model).toBe("gpt4o");
    expect(rows[0].total_votes).toBe(8);
  });
});
