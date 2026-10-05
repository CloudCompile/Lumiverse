/**
 * Filesystem safety checks for SQLite's WAL journal mode.
 *
 * WAL mode is safe on a local block device, but it is NOT safe on filesystems
 * that do not provide POSIX advisory locking plus a shared, coherent `-shm`
 * mapping across processes. Network/object-storage filesystems (NFS, SMB/CIFS,
 * FUSE mounts such as Mountpoint-for-S3, 9p) routinely violate those guarantees:
 * two processes can both believe they hold the write lock, or the `-shm` index
 * is not coherent between hosts. The classic result is
 *
 *   SQLiteError: database disk image is malformed
 *
 * during ordinary runtime queries (`deleteTemporaryChats`, `listChatSummaries`,
 * …) even though `PRAGMA integrity_check` passed at startup. Lumiverse runs the
 * main server plus several child processes that each open the same database, so
 * it is exactly this multi-process scenario.
 *
 * A rollback-journal (`journal_mode = DELETE`) database relies only on the
 * primary file's POSIX advisory lock, which these mounts honor far more
 * reliably, so it remains usable (at some throughput cost) where WAL is not.
 *
 * We therefore select the journal mode per database directory:
 *   - known network/object filesystem type  -> DELETE
 *   - WAL cannot actually be enabled there  -> DELETE
 *   - otherwise                             -> WAL (unchanged default)
 *
 * `LUMIVERSE_SQLITE_JOURNAL_MODE` overrides the decision for operators who
 * know their storage is safe (or unsafe).
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

export type SqliteJournalMode = "WAL" | "DELETE";

/** Linux `statfs` magic numbers for filesystems where WAL is unsafe. */
const UNSAFE_SUPER_MAGIC: ReadonlyMap<number, string> = new Map([
  [0x6969, "NFS"],
  [0x517b, "SMB"],
  [0xff534d42, "CIFS"],
  [0x65735546, "FUSE"],
  [0x01021997, "9p"],
  [0x5346414f, "AFS"],
  [0x73757245, "Coda"],
  [0xfe534d42, "SMB2"],
]);

/**
 * True when the `statfs` filesystem type is known to provide unreliable
 * cross-process locking / `-shm` coherence, so SQLite WAL must not be used.
 */
export function isNetworkOrObjectFilesystemType(type: number): boolean {
  if (!Number.isFinite(type)) return false;
  return UNSAFE_SUPER_MAGIC.has(type >>> 0);
}

export function describeFilesystemType(type: number): string {
  if (!Number.isFinite(type)) return "unknown";
  const name = UNSAFE_SUPER_MAGIC.get(type >>> 0);
  return name ?? `0x${(type >>> 0).toString(16)}`;
}

export interface FilesystemTypeProbe {
  type: number;
  /** Human-readable name for the magic, when recognized. */
  name: string;
}

/** Read the `statfs` filesystem type for `dir`; null when it cannot be read. */
export function readFilesystemType(dir: string): FilesystemTypeProbe | null {
  try {
    const stats = statfsSync(dir, { bigint: true });
    const type = Number(stats.type);
    if (!Number.isFinite(type)) return null;
    return { type, name: describeFilesystemType(type) };
  } catch {
    return null;
  }
}

export interface WalProbeResult {
  supported: boolean;
  /** Short, non-secret explanation of the observed mode. */
  detail?: string;
}

/**
 * Verify that SQLite can actually operate a file in `dir` under WAL mode. The
 * `-shm` index is not created by the `journal_mode` switch alone — it appears on
 * the first write transaction — so the probe performs a real write and confirms
 * the sidecar materialized and is still readable. Uses a throwaway database and
 * cleans up after itself, including any sidecar left behind by an unclean exit.
 */
export function probeWalSupport(dir: string): WalProbeResult {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const probePath = join(dir, `.lumiverse-wal-probe-${suffix}.db`);
  let db: Database | null = null;
  try {
    db = new Database(probePath);
    const row = db.query("PRAGMA journal_mode = WAL").get() as Record<string, unknown> | null;
    const observed = String(row ? Object.values(row)[0] : "").toLowerCase();
    if (observed !== "wal") {
      return { supported: false, detail: `journal_mode=${observed || "unknown"}` };
    }
    // Force a WAL write so SQLite opens/creates the shared-memory index. On a
    // filesystem without coherent locking/mmap this is where it fails.
    db.run("CREATE TABLE probe (value INTEGER)");
    db.run("INSERT INTO probe (value) VALUES (1)");
    const readBack = db.query("SELECT value FROM probe").get() as { value?: number } | null;
    if (readBack?.value !== 1) {
      return { supported: false, detail: "WAL write/read-back mismatch" };
    }
    if (!existsSync(`${probePath}-shm`)) {
      return { supported: false, detail: "WAL write succeeded but -shm was not created" };
    }
    return { supported: true, detail: "journal_mode=wal" };
  } catch (err) {
    return { supported: false, detail: describeError(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
    for (const path of [probePath, `${probePath}-wal`, `${probePath}-shm`]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(err);
}

function normalizeOverride(raw: string | undefined): SqliteJournalMode | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "wal") return "WAL";
  if (value === "delete" || value === "rollback" || value === "journal") return "DELETE";
  return null;
}

export interface SqliteJournalModeResolution {
  mode: SqliteJournalMode;
  /** Present when the mode is not the plain default (for startup logging). */
  reason?: string;
}

export interface ResolveSqliteJournalModeOptions {
  dir: string;
  override?: string;
  readType?: (dir: string) => FilesystemTypeProbe | null;
  probeWal?: (dir: string) => WalProbeResult;
}

// Filesystem layout and the effective override cannot change while a process
// runs, and several call sites may open the database more than once. Cache the
// decision per directory so the on-disk WAL probe runs once per process.
const resolutionCache = new Map<string, SqliteJournalModeResolution>();

function clearResolutionCache(): void {
  resolutionCache.clear();
}

/**
 * Choose the journal mode for a database that lives in `dir`. Prefers WAL and
 * only falls back to DELETE when the filesystem is known to be unsafe for it.
 */
export function resolveSqliteJournalMode(options: ResolveSqliteJournalModeOptions): SqliteJournalModeResolution {
  const cacheKey = `${options.dir}\u0000${options.override ?? ""}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached) return cached;

  const resolution = detectSqliteJournalMode(options);
  resolutionCache.set(cacheKey, resolution);
  return resolution;
}

function detectSqliteJournalMode(options: ResolveSqliteJournalModeOptions): SqliteJournalModeResolution {
  const override = normalizeOverride(options.override);
  if (override) {
    return { mode: override, reason: `LUMIVERSE_SQLITE_JOURNAL_MODE=${options.override?.trim()}` };
  }

  const readType = options.readType ?? readFilesystemType;
  const fsType = readType(options.dir);
  if (fsType && isNetworkOrObjectFilesystemType(fsType.type)) {
    return {
      mode: "DELETE",
      reason: `${fsType.name} filesystem at ${options.dir} does not provide reliable cross-process WAL locking`,
    };
  }

  const probeWal = options.probeWal ?? probeWalSupport;
  const probe = probeWal(options.dir);
  if (!probe.supported) {
    return {
      mode: "DELETE",
      reason: `WAL is not usable at ${options.dir} (${probe.detail ?? "probe failed"})`,
    };
  }

  return { mode: "WAL" };
}

/** Exposed for tests that exercise the probing paths with fresh state. */
export const __testing = { clearResolutionCache };
