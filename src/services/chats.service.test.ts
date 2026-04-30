import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { listRecentChats, listRecentChatsGrouped } from "./chats.service";

function initChatsTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();

  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    image_id TEXT
  )`);

  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    character_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function seedCharacter(id: string, name: string): void {
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run(id, "u1", name);
}

function seedChat(id: string, characterId: string, name: string, metadata: string, updatedAt: number): void {
  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, "u1", characterId, name, metadata, updatedAt, updatedAt);
}

beforeEach(() => {
  initChatsTestDb();
  seedCharacter("c1", "Alpha");
  seedCharacter("c2", "Beta");
});

afterEach(() => {
  closeDatabase();
});

describe("recent chats", () => {
  test("loads recent chats with malformed metadata", () => {
    seedChat("bad", "c1", "Bad metadata", "not json", 200);
    seedChat("good", "c2", "Good metadata", "{}", 100);

    const result = listRecentChats("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.data.map((chat) => chat.id)).toEqual(["bad", "good"]);
    expect(result.data[0].metadata).toEqual({});
  });

  test("groups recent chats without SQLite JSON extraction", () => {
    seedChat("c1-old", "c1", "Alpha old", "{}", 100);
    seedChat("group", "c1", "Group", JSON.stringify({ group: true, character_ids: ["c1", "c2"] }), 150);
    seedChat("c1-new", "c1", "Alpha new", "{}", 200);
    seedChat("bad", "c2", "Bad metadata", "not json", 250);

    const result = listRecentChatsGrouped("u1", { limit: 10, offset: 0 });

    expect(result.total).toBe(3);
    expect(result.data.map((chat) => chat.latest_chat_id)).toEqual(["bad", "c1-new", "group"]);
    expect(result.data[1].chat_count).toBe(2);
    expect(result.data[2].is_group).toBe(true);
    expect(result.data[2].group_character_ids).toEqual(["c1", "c2"]);
  });
});
