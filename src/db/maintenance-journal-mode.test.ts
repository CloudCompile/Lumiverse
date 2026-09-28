import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBaseDatabasePragmas } from "./maintenance";
import { __testing } from "./sqlite-filesystem-safety";

const created: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiverse-journal-test-"));
  created.push(dir);
  return join(dir, "lumiverse.db");
}

afterEach(() => {
  __testing.clearResolutionCache();
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function journalModeOf(db: Database): string {
  const row = db.query("PRAGMA journal_mode").get() as Record<string, unknown> | null;
  return String(row ? Object.values(row)[0] : "").toLowerCase();
}

describe("applyBaseDatabasePragmas journal mode", () => {
  test("uses WAL on a local filesystem (unchanged default)", () => {
    const db = new Database(tempDbPath());
    try {
      const mode = applyBaseDatabasePragmas(db);
      expect(mode).toBe("WAL");
      expect(journalModeOf(db)).toBe("wal");
    } finally {
      db.close();
    }
  });

  test("honors an explicit DELETE override even on local storage", () => {
    const previous = process.env.LUMIVERSE_SQLITE_JOURNAL_MODE;
    process.env.LUMIVERSE_SQLITE_JOURNAL_MODE = "DELETE";
    try {
      const db = new Database(tempDbPath());
      try {
        const mode = applyBaseDatabasePragmas(db);
        expect(mode).toBe("DELETE");
        expect(journalModeOf(db)).toBe("delete");
      } finally {
        db.close();
      }
    } finally {
      if (previous === undefined) delete process.env.LUMIVERSE_SQLITE_JOURNAL_MODE;
      else process.env.LUMIVERSE_SQLITE_JOURNAL_MODE = previous;
    }
  });
});
