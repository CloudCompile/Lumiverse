import { beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as svc from "./leaderboard.service";

function setup() {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
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

describe("leaderboard import isolation", () => {
  let db: ReturnType<typeof getDb>;
  beforeEach(() => {
    db = setup();
  });

  test("importing as user B does not overwrite user A's vote row", () => {
    db.run(
      `INSERT INTO leaderboard_votes
       (id, user_id, message_id, swipe_id, chat_id, model, provider, vote, canonical_model, raw_model, created_at)
       VALUES (1, 'user-a', 'msg-a', 0, 'chat-a', 'gpt', 'openai', 1, 'gpt', 'gpt', 1000)`,
    );

    svc.importLeaderboardData("user-b", {
      votes: [{ id: 1, message_id: "msg-b", swipe_id: 0, chat_id: "chat-b", model: "claude", provider: "anthropic", vote: 1 }],
    });

    const rows = db.query(`SELECT id, user_id, message_id FROM leaderboard_votes ORDER BY id`).all() as Array<{
      id: number;
      user_id: string;
      message_id: string;
    }>;

    // Both users must retain their own row; user A's row must be untouched.
    const a = rows.find((r) => r.user_id === "user-a");
    expect(a).toBeTruthy();
    expect(a!.message_id).toBe("msg-a");
    expect(rows.length).toBe(2);
  });

  test("importing as user B does not overwrite user A's roulette vote row", () => {
    db.run(
      `INSERT INTO leaderboard_roulette_votes
       (id, user_id, left_model, left_provider, left_canonical_model, right_model, right_provider,
        right_canonical_model, winner, created_at)
       VALUES (1, 'user-a', 'x', 'p', 'x', 'y', 'p', 'y', 'left', 1000)`,
    );

    svc.importLeaderboardData("user-b", {
      roulette_votes: [{
        id: 1, left_model: "m1", left_provider: "p2", left_canonical_model: "m1",
        right_model: "m2", right_provider: "p2", right_canonical_model: "m2", winner: "right",
      }],
    });

    const rows = db.query(`SELECT id, user_id FROM leaderboard_roulette_votes ORDER BY id`).all() as Array<{
      id: number;
      user_id: string;
    }>;
    expect(rows.find((r) => r.user_id === "user-a")).toBeTruthy();
    expect(rows.length).toBe(2);
  });
});
