/**
 * SQLite corruption detection, quarantine, and best-effort recovery.
 *
 * Corruption surfaces in two shapes that callers must treat the same way:
 *
 *   - `SQLITE_CORRUPT`  — a valid header but a broken b-tree/page (errno 11).
 *   - `SQLITE_NOTADB`   — the file is not a database at all, e.g. a truncated
 *     or overwritten header (errno 26). This is what a power-loss or a
 *     half-written file produces, and it is the case the original recovery
 *     path missed entirely.
 *
 * Recovery never destroys the broken file: it is moved aside into a
 * timestamped `.corrupt-<ISO>` sibling so an operator can still attempt an
 * offline `sqlite3 .recover` before discarding it.
 */

import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";

/** SQLite extended result codes and errnos that indicate file corruption. */
const CORRUPTION_CODES = new Set([
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_CORRUPT_VTAB",
  "SQLITE_CORRUPT_INDEX",
]);

const CORRUPTION_ERRNOS = new Set([
  11, // SQLITE_CORRUPT
  26, // SQLITE_NOTADB
]);

const CORRUPTION_MESSAGE = /database disk image is malformed|file is not a database|malformed database schema|is encrypted or is not a database/i;

/**
 * Whether an error thrown by `bun:sqlite` indicates a corrupt or unreadable
 * database file. Accepts unknown input so it can be used directly in `catch`.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: unknown; errno?: unknown; message?: unknown };

  if (typeof candidate.code === "string" && CORRUPTION_CODES.has(candidate.code)) {
    return true;
  }
  if (typeof candidate.errno === "number" && CORRUPTION_ERRNOS.has(candidate.errno)) {
    return true;
  }
  return typeof candidate.message === "string" && CORRUPTION_MESSAGE.test(candidate.message);
}

export interface QuarantinedDatabase {
  /** The path the corrupt file was moved to, or null when nothing was moved. */
  path: string | null;
  /** Whether the original file existed and was moved aside. */
  moved: boolean;
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Move a corrupt database and its WAL/SHM sidecars out of the way so a fresh
 * file can be created at the original path. Sidecars are moved first because
 * a stale `-wal` next to a fresh main file would be replayed into it.
 */
export function quarantineDatabaseFiles(dbPath: string): QuarantinedDatabase {
  const suffix = timestampSuffix();
  let moved = false;
  let firstPath: string | null = null;

  for (const sidecar of ["-wal", "-shm"]) {
    const from = `${dbPath}${sidecar}`;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, `${from}.corrupt-${suffix}`);
    } catch {
      // Best effort: a sidecar that cannot be moved must not block recovery.
    }
  }

  if (existsSync(dbPath)) {
    const target = `${dbPath}.corrupt-${suffix}`;
    try {
      renameSync(dbPath, target);
      moved = true;
      firstPath = target;
    } catch (err) {
      // If the file is locked (another process holds it open) we cannot move
      // it. Report that honestly rather than silently deleting user data.
      throw new Error(
        `Database is corrupt and could not be quarantined (still open elsewhere?): ${dbPath}`,
        { cause: err },
      );
    }
  }

  return { path: firstPath, moved };
}

export interface DatabaseRecoveryResult {
  /** True when a usable database now exists at `dbPath`. */
  recovered: boolean;
  /** Path the corrupt original was moved to, when it existed. */
  quarantinedPath: string | null;
  /** How many tables were copied out of the corrupt file, when salvage ran. */
  salvagedTables: number;
  /** Human-readable summary for logs. */
  detail: string;
}

/**
 * Copy every readable schema object out of a corrupt database into a fresh
 * file.
 *
 * Tables come first (with their data), then indexes, views, and triggers, so
 * the salvage is structurally complete: promoting a half-built schema would
 * leave migrations believing they had already run while indexes and triggers
 * were silently missing. Any object whose pages are damaged is skipped and
 * counted, turning "lose everything" into "lose only the damaged table".
 */
function salvageTables(sourcePath: string, targetPath: string): number {
  const target = new Database(targetPath);
  let copied = 0;
  const escapedSource = sourcePath.replace(/'/g, "''");
  try {
    target.run(`ATTACH DATABASE '${escapedSource}' AS corrupt`);

    const objects = target
      .query("SELECT type, name, sql FROM corrupt.sqlite_master WHERE sql IS NOT NULL")
      .all() as { type: string; name: string; sql: string }[];

    const order: Record<string, number> = { table: 0, index: 1, view: 2, trigger: 3 };
    objects.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

    for (const object of objects) {
      if (object.name.startsWith("sqlite_")) continue;
      try {
        if (object.type === "table") {
          target.run(object.sql.replace(/\bCREATE\s+TABLE\b/i, "CREATE TABLE IF NOT EXISTS"));
          target.run(`INSERT INTO main."${object.name}" SELECT * FROM corrupt."${object.name}"`);
          copied++;
        } else if (object.type === "index") {
          target.run(object.sql.replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, "CREATE $1INDEX IF NOT EXISTS"));
        } else if (object.type === "view") {
          target.run(object.sql.replace(/\bCREATE\s+VIEW\b/i, "CREATE VIEW IF NOT EXISTS"));
        } else if (object.type === "trigger") {
          target.run(object.sql.replace(/\bCREATE\s+TRIGGER\b/i, "CREATE TRIGGER IF NOT EXISTS"));
        }
      } catch {
        // A single unreadable object is not fatal; keep whatever else works.
      }
    }
  } finally {
    try {
      target.run("DETACH DATABASE corrupt");
    } catch {
      // Detach fails when ATTACH itself failed; nothing to release.
    }
    target.close(true);
  }
  return copied;
}

/**
 * Recover a corrupt database file in place.
 *
 * Steps: quarantine the broken file (and sidecars) → build a fresh database,
 * preferring a salvage of the readable tables → report the outcome. The
 * caller opens the resulting file normally.
 */
export function recoverDatabaseFile(dbPath: string): DatabaseRecoveryResult {
  const quarantined = quarantineDatabaseFiles(dbPath);
  const salvageTarget = `${dbPath}.salvage-${timestampSuffix()}`;

  let salvagedTables = 0;
  try {
    salvagedTables = salvageTables(quarantined.path ?? dbPath, salvageTarget);
  } catch {
    salvagedTables = 0;
  }

  if (salvagedTables > 0) {
    try {
      // Promote the salvage file into place so migrations run against it.
      renameSync(salvageTarget, dbPath);
    } catch {
      salvagedTables = 0;
    }
  }

  if (salvagedTables === 0) {
    // Nothing readable: leave a clean slate for migrations to rebuild.
    if (existsSync(salvageTarget)) {
      try {
        renameSync(salvageTarget, `${salvageTarget}.unused`);
      } catch {
        // Ignore; the empty target is harmless next to a fresh database.
      }
    }
  }

  const detail = salvagedTables > 0
    ? `salvaged ${salvagedTables} table(s) from the corrupt database`
    : "no tables could be salvaged; starting from an empty database";

  return {
    recovered: true,
    quarantinedPath: quarantined.path,
    salvagedTables,
    detail,
  };
}
