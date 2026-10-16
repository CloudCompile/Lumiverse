import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSqliteCorruptionError,
  quarantineDatabaseFiles,
  recoverDatabaseFile,
} from "./corruption";

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiverse-corruption-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a valid two-table database, then corrupt the second table's pages. */
function corruptMiddlePage(path: string): void {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE good (id INTEGER PRIMARY KEY, v TEXT)");
  db.run("CREATE TABLE bad (id INTEGER PRIMARY KEY, v TEXT)");
  db.run("CREATE INDEX idx_good_v ON good (v)");
  for (let i = 0; i < 800; i++) {
    db.query("INSERT INTO good (v) VALUES (?)").run(`g${i}`);
    db.query("INSERT INTO bad (v) VALUES (?)").run(`b${i}`);
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(true);

  const buffer = readFileSync(path);
  // Corrupt the tail of the file, where the second table's leaf pages live.
  const start = Math.max(0, buffer.length - 4000);
  for (let i = start; i < buffer.length; i++) buffer[i] = 0x5a;
  writeFileSync(path, buffer);
}

describe("SQLite corruption detection", () => {
  test("recognises SQLITE_NOTADB and SQLITE_CORRUPT result codes", () => {
    expect(isSqliteCorruptionError({ code: "SQLITE_CORRUPT" })).toBe(true);
    expect(isSqliteCorruptionError({ code: "SQLITE_NOTADB" })).toBe(true);
    expect(isSqliteCorruptionError({ errno: 11 })).toBe(true);
    expect(isSqliteCorruptionError({ errno: 26 })).toBe(true);
    expect(isSqliteCorruptionError({ message: "database disk image is malformed" })).toBe(true);
    expect(isSqliteCorruptionError({ message: "file is not a database" })).toBe(true);
  });

  test("ignores unrelated failures", () => {
    expect(isSqliteCorruptionError(new Error("disk I/O error"))).toBe(false);
    expect(isSqliteCorruptionError({ code: "SQLITE_BUSY" })).toBe(false);
    expect(isSqliteCorruptionError(null)).toBe(false);
    expect(isSqliteCorruptionError("nope")).toBe(false);
  });

  test("a real unreadable file raises an error the detector accepts", () => {
    const path = join(tempDir(), "broken.db");
    writeFileSync(path, Buffer.from("not a database header at all".repeat(20)));
    const db = new Database(path);
    try {
      db.query("PRAGMA integrity_check").get();
      throw new Error("expected the query to fail on a non-database file");
    } catch (err) {
      expect(isSqliteCorruptionError(err)).toBe(true);
    } finally {
      db.close(true);
    }
  });
});

describe("database quarantine", () => {
  test("moves the database and its sidecars aside without deleting them", () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.db");
    writeFileSync(path, "corrupt");
    writeFileSync(`${path}-wal`, "wal");
    writeFileSync(`${path}-shm`, "shm");

    const result = quarantineDatabaseFiles(path);

    expect(result.moved).toBe(true);
    expect(result.path).not.toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.includes(".corrupt-")).length).toBe(3);
  });

  test("reports no move when the file does not exist", () => {
    const result = quarantineDatabaseFiles(join(tempDir(), "absent.db"));
    expect(result.moved).toBe(false);
    expect(result.path).toBeNull();
  });
});

describe("database recovery", () => {
  test("salvages readable tables from a partially corrupt database", () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.db");
    corruptMiddlePage(path);

    const result = recoverDatabaseFile(path);

    expect(result.recovered).toBe(true);
    expect(result.salvagedTables).toBeGreaterThan(0);
    expect(result.quarantinedPath).not.toBeNull();

    const recovered = new Database(path);
    try {
      const row = recovered.query("SELECT COUNT(*) c FROM good").get() as { c: number };
      expect(row.c).toBe(800);
      // The index survives the salvage, not just the table data.
      const index = recovered
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_good_v'")
        .get();
      expect(index).toEqual({ name: "idx_good_v" });
    } finally {
      recovered.close(true);
    }
  });

  test("starts from an empty database when nothing is readable", () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.db");
    writeFileSync(path, Buffer.from("this is not a sqlite database at all".repeat(20)));

    const result = recoverDatabaseFile(path);

    expect(result.recovered).toBe(true);
    expect(result.salvagedTables).toBe(0);
    expect(result.quarantinedPath).not.toBeNull();

    // A fresh, usable database now exists at the original path.
    const fresh = new Database(path);
    try {
      fresh.run("CREATE TABLE probe (id INTEGER)");
      expect(fresh.query("SELECT COUNT(*) c FROM probe").get()).toEqual({ c: 0 });
    } finally {
      fresh.close(true);
    }
  });
});
