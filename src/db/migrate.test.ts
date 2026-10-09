import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrate";

describe("database migrations", () => {
  test("fresh bootstrap applies the preset cache revision exactly once", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db);
      const columns = db.query("PRAGMA table_info(presets)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "cache_revision")).toBe(true);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("093_preset_cache_revision.sql"),
      ).toEqual({ name: "093_preset_cache_revision.sql" });
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("094_regex_actions.sql"),
      ).toEqual({ name: "094_regex_actions.sql" });
      const regexColumns = db.query("PRAGMA table_info(regex_scripts)").all() as Array<{ name: string }>;
      expect(regexColumns.some((column) => column.name === "actions")).toBe(true);
      expect(regexColumns.some((column) => column.name === "owner_extension_identifier")).toBe(true);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("101_regex_script_extension_ownership.sql"),
      ).toEqual({ name: "101_regex_script_extension_ownership.sql" });
      const linkColumns = db.query("PRAGMA table_info(lumihub_link)").all() as Array<{ name: string }>;
      expect(linkColumns.some((column) => column.name === "user_id")).toBe(true);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("095_lumihub_link_user_scope.sql"),
      ).toEqual({ name: "095_lumihub_link_user_scope.sql" });
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("107_world_book_entry_order_index.sql"),
      ).toEqual({ name: "107_world_book_entry_order_index.sql" });
      const entryIndexes = db.query("PRAGMA index_list('world_book_entries')").all() as Array<{ name: string }>;
      expect(entryIndexes.map((index) => index.name)).toContain("idx_wbe_world_book_order");
    } finally {
      db.close();
    }
  });

  test("assigns the legacy instance link to the historical owner", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL)`);
      db.run(`INSERT INTO "user" (id, createdAt) VALUES ('owner', 1), ('tenant', 2)`);
      db.run(`CREATE TABLE lumihub_link (
        id TEXT PRIMARY KEY,
        lumihub_url TEXT NOT NULL,
        ws_url TEXT NOT NULL,
        instance_name TEXT NOT NULL,
        link_token_encrypted TEXT NOT NULL,
        link_token_iv TEXT NOT NULL,
        link_token_tag TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        last_connected_at TEXT,
        share_usage_stats INTEGER NOT NULL DEFAULT 0
      )`);
      db.run(`INSERT INTO lumihub_link VALUES (
        'legacy', 'https://hub.test', 'wss://hub.test', 'Legacy', 'token', 'iv', 'tag', 'instance', 'now', NULL, 0
      )`);

      const sql = await Bun.file(`${import.meta.dir}/migrations/095_lumihub_link_user_scope.sql`).text();
      db.run(sql);

      expect(db.query("SELECT user_id FROM lumihub_link WHERE id = 'legacy'").get()).toEqual({ user_id: "owner" });
      db.run(`INSERT INTO lumihub_link (
        id, user_id, lumihub_url, ws_url, instance_name, link_token_encrypted,
        link_token_iv, link_token_tag, instance_id, linked_at
      ) VALUES ('tenant-link', 'tenant', 'https://hub.test', 'wss://hub.test', 'Tenant', 'token', 'iv', 'tag', 'instance-2', 'now')`);
      expect(db.query("SELECT COUNT(*) AS count FROM lumihub_link").get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  test("moves extension-owned preset rows from restore snapshots to independent state", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`CREATE TABLE settings (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      )`);
      db.run(`CREATE TABLE regex_scripts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        preset_id TEXT,
        disabled INTEGER NOT NULL,
        owner_extension_identifier TEXT
      )`);
      db.run(`INSERT INTO regex_scripts VALUES
        ('extension-enabled', 'user', 'preset-1', 1, 'extension.a'),
        ('extension-disabled', 'user', 'preset-1', 0, 'extension.a'),
        ('host-enabled', 'user', 'preset-1', 1, NULL),
        ('no-snapshot', 'user', 'preset-2', 1, 'extension.a'),
        ('malformed-snapshot', 'user', 'preset-3', 0, 'extension.a')`);
      db.run(`INSERT INTO settings VALUES
        ('presetRegexEnabled:preset-1', '["extension-enabled","host-enabled"]', 'user'),
        ('presetRegexEnabled:preset-3', 'not-json', 'user')`);

      const sql = await Bun.file(`${import.meta.dir}/migrations/115_extension_preset_regex_state.sql`).text();
      db.run(sql);

      expect(db.query("SELECT id, disabled FROM regex_scripts ORDER BY id").all()).toEqual([
        { id: "extension-disabled", disabled: 1 },
        { id: "extension-enabled", disabled: 0 },
        { id: "host-enabled", disabled: 1 },
        { id: "malformed-snapshot", disabled: 0 },
        { id: "no-snapshot", disabled: 1 },
      ]);
      expect(db.query("SELECT value FROM settings WHERE key = 'presetRegexEnabled:preset-1'").get())
        .toEqual({ value: '["host-enabled"]' });
      expect(db.query("SELECT value FROM settings WHERE key = 'presetRegexEnabled:preset-3'").get())
        .toEqual({ value: "not-json" });
    } finally {
      db.close();
    }
  });

  test("backfills chat chunk order from canonical message positions", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        index_in_chat INTEGER NOT NULL
      )`);
      db.run(`CREATE TABLE chat_chunks (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_ids TEXT NOT NULL,
        message_range_start INTEGER,
        message_range_end INTEGER
      )`);
      db.run(`INSERT INTO messages VALUES
        ('m10', 'chat', 10),
        ('m11', 'chat', 11),
        ('m12', 'chat', 12)`);
      db.run(`INSERT INTO chat_chunks VALUES
        ('chunk-a', 'chat', '["m10","m11"]', NULL, NULL),
        ('chunk-b', 'chat', '["deleted","m12"]', NULL, NULL),
        ('malformed', 'chat', 'not-json', NULL, NULL)`);

      const sql = await Bun.file(
        `${import.meta.dir}/migrations/116_backfill_chat_chunk_message_ranges.sql`,
      ).text();
      db.run(sql);

      expect(db.query(
        `SELECT id, message_range_start, message_range_end
         FROM chat_chunks ORDER BY id`,
      ).all()).toEqual([
        { id: "chunk-a", message_range_start: 10, message_range_end: 11 },
        { id: "chunk-b", message_range_start: 12, message_range_end: 12 },
        { id: "malformed", message_range_start: null, message_range_end: null },
      ]);
    } finally {
      db.close();
    }
  });
});
