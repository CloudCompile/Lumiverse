/**
 * LanceDB storage placement + commit-compatibility checks.
 *
 * LanceDB commits rely on real local-filesystem semantics — most importantly an
 * atomic rename while replacing a manifest. Object-storage mounts (Hugging Face
 * Storage Buckets backed by Mountpoint-for-S3, other FUSE layers) do not provide
 * those semantics, and LanceDB fails every commit with:
 *
 *   "the filesystem does not support an operation required for safe Lance commits"
 *
 * Vectors are derived state: every row is rebuildable from the durable SQLite
 * tables under `DATA_DIR`. So when the configured LanceDB directory sits on a
 * mount Lance cannot commit to, we relocate the store to genuinely local
 * (ephemeral) disk and let the startup rebuild re-create vectors from SQLite.
 * The application database itself stays on the persistent mount.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface AtomicRenameProbeResult {
  supported: boolean;
  /** Short, non-secret explanation when `supported` is false. */
  detail?: string;
}

function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    const parts = [typeof code === "string" ? code : null, typeof message === "string" ? message : null]
      .filter(Boolean);
    if (parts.length > 0) return parts.join(": ");
  }
  return String(err);
}

/**
 * Probe whether `dir` supports the local-filesystem semantics LanceDB needs for
 * a safe manifest commit: an atomic rename (with overwrite) plus a directory
 * fsync. Creates the directory if needed. Uses only throwaway files and cleans
 * them up.
 *
 * The probe deliberately overwrites an *existing* target file, mirroring how
 * Lance swaps a new manifest over the current one. Some object-storage FUSE
 * layers permit the rename syscall itself and only fail when the target is
 * opened for truncation, or reject durability syncs outright, so weaker probes
 * can report success on a mount Lance cannot actually commit to.
 */
export function probeAtomicRenameSupport(dir: string): AtomicRenameProbeResult {
  const probeSource = join(dir, `.lancedb-commit-probe-${process.pid}.src`);
  const probeTarget = join(dir, `.lancedb-commit-probe-${process.pid}.dst`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { supported: false, detail: `cannot create directory: ${describeError(err)}` };
  }
  let dirFd: number | null = null;
  try {
    writeFileSync(probeTarget, "existing", "utf8");
    writeFileSync(probeSource, "replacement", "utf8");
    // Overwriting an existing file via rename is the operation LanceDB relies
    // on when it swaps a new manifest into place.
    renameSync(probeSource, probeTarget);
    // Durability sync on the directory: another operation Lance performs when
    // committing. FUSE/object-storage layers commonly reject this.
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
    return { supported: true };
  } catch (err) {
    return { supported: false, detail: describeError(err) };
  } finally {
    if (dirFd !== null) {
      try { closeSync(dirFd); } catch { /* best effort */ }
    }
    for (const path of [probeSource, probeTarget]) {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
    }
  }
}

interface MountEntry {
  mountPoint: string;
  fsType: string;
  source: string;
}

/**
 * Filesystem types that cannot provide local Lance commit semantics. Matched as
 * substrings because the kernel reports FUSE variants inconsistently across
 * distributions (`fuse.s3fs`, `fuse.mountpoint-s3`, plain `fuse`, ...).
 */
const NON_LOCAL_FS_MARKERS = [
  "s3fs",
  "mountpoint",
  "gcsfuse",
  "blobfuse",
  "rclone",
  "sshfs",
  "nfs",
  "cifs",
  "smb",
  "9p",
  "fuse",
];

function readMountTable(mountsPath: string): MountEntry[] {
  let raw: string;
  try {
    raw = readFileSync(mountsPath, "utf8");
  } catch {
    return [];
  }
  const entries: MountEntry[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    entries.push({ source: parts[0], mountPoint: parts[1], fsType: parts[2] });
  }
  return entries;
}

function decodeMountPath(path: string): string {
  return path.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
}

/**
 * Find the mount entry whose mount point is the longest prefix of `path` (i.e.
 * the filesystem actually backing `path`). Returns null when it cannot be
 * determined, so callers can fall back to the rename probe alone.
 */
export function findMountForPath(path: string, mountsPath = "/proc/self/mounts"): MountEntry | null {
  const target = resolve(path);
  let best: MountEntry | null = null;
  for (const entry of readMountTable(mountsPath)) {
    const mountPoint = decodeMountPath(entry.mountPoint);
    const matches = target === mountPoint
      || target.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
    if (!matches) continue;
    if (!best || mountPoint.length > best.mountPoint.length) best = { ...entry, mountPoint };
  }
  return best;
}

export interface StorageKind {
  /** True when `path` is backed by a mount that cannot commit Lance transactions. */
  nonLocal: boolean;
  /** Human-readable, non-secret description for diagnostics. */
  detail: string;
}

/**
 * Classify the mount backing `path`. This is a *signal*, not the sole decision
 * maker — a failed atomic-rename probe is what actually forces relocation. It
 * catches the case where an object-storage mount happens to satisfy the probe
 * but is still known to be unsafe for Lance commits.
 */
export function classifyStoragePath(path: string, mountsPath = "/proc/self/mounts"): StorageKind {
  const mount = findMountForPath(path, mountsPath);
  if (!mount) return { nonLocal: false, detail: "mount table unavailable" };
  const haystack = `${mount.fsType} ${mount.source}`.toLowerCase();
  const nonLocal = NON_LOCAL_FS_MARKERS.some((marker) => haystack.includes(marker));
  return {
    nonLocal,
    detail: `${mount.mountPoint} (${mount.fsType}${mount.source ? `, ${mount.source}` : ""})`,
  };
}

export interface LanceDbStorageResolution {
  /** Effective directory that should back the LanceDB store. */
  dir: string;
  /** True when the store was moved off the configured directory. */
  ephemeral: boolean;
  /** Human-readable reason, present only when `ephemeral` is true. */
  reason?: string;
  /** Filesystem description for the resolved directory, for diagnostics. */
  storageDetail: string;
}

export interface ResolveLanceDbStorageDirOptions {
  dataDir: string;
  /** Explicit operator override (`LUMIVERSE_LANCEDB_DIR`). Wins when present. */
  configuredDir?: string | null;
  /** Explicit ephemeral root (`LUMIVERSE_RUNTIME_DIR`). */
  runtimeDir?: string | null;
  /** Ephemeral fallback root; defaults to the in-container runtime dir / temp. */
  ephemeralRoot?: string;
  probe?: (dir: string) => AtomicRenameProbeResult;
  classify?: (dir: string) => StorageKind;
}

const CONTAINER_RUNTIME_DIR = "/app/runtime-data";

/**
 * Choose where relocated (ephemeral) vectors live. Prefers the operator's
 * `LUMIVERSE_RUNTIME_DIR`, then the container runtime directory
 * `/app/runtime-data` (local overlay, never the persistent mount), then the OS
 * temp directory. Each candidate must actually be creatable and commit-capable
 * before it is used.
 */
function resolveEphemeralRoot(
  options: ResolveLanceDbStorageDirOptions,
  probe: (dir: string) => AtomicRenameProbeResult,
): string {
  const candidates = [
    options.runtimeDir?.trim() ? resolve(options.runtimeDir.trim()) : null,
    options.ephemeralRoot ?? null,
    CONTAINER_RUNTIME_DIR,
    join(tmpdir(), "lumiverse-runtime-data"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (probe(join(candidate, "lancedb")).supported) return candidate;
  }
  return candidates[candidates.length - 1];
}

export function resolveLanceDbStorageDir(options: ResolveLanceDbStorageDirOptions): LanceDbStorageResolution {
  const probe = options.probe ?? probeAtomicRenameSupport;
  const classify = options.classify ?? classifyStoragePath;
  const configured = options.configuredDir?.trim();
  // An explicit override is honored as-is. The operator asked for this path, so
  // we do not relocate it — but we still report whether commits can land.
  if (configured) {
    const dir = resolve(configured);
    const kind = classify(dir);
    const overrideProbe = probe(dir);
    return {
      dir,
      ephemeral: false,
      storageDetail: kind.detail,
      ...(overrideProbe.supported
        ? {}
        : { reason: `${dir} does not support atomic rename (LanceDB commit requirement)` }),
    };
  }

  const localDir = join(options.dataDir, "lancedb");
  const localKind = classify(localDir);
  const localProbe = probe(localDir);
  if (localProbe.supported && !localKind.nonLocal) {
    return { dir: localDir, ephemeral: false, storageDetail: localKind.detail };
  }

  const root = resolveEphemeralRoot(options, probe);
  const ephemeralDir = join(root, "lancedb");
  const ephemeralProbe = probe(ephemeralDir);
  // Describe the rejected location by its mount, not by the literal path, so
  // normal ephemeral operation never logs the persistent dataset path.
  const failure = localProbe.supported
    ? `${localKind.detail} is an object-storage/network mount, which cannot safely commit Lance transactions`
    : `DATA_DIR filesystem (${localKind.detail}) does not support atomic rename (LanceDB commit requirement): ${localProbe.detail ?? "unknown error"}`;
  if (ephemeralProbe.supported) {
    return {
      dir: ephemeralDir,
      ephemeral: true,
      reason: failure,
      storageDetail: classify(ephemeralDir).detail,
    };
  }

  // Neither location supports Lance commits. Keep the configured directory so
  // behavior is unchanged, and let the caller surface the failure loudly.
  return {
    dir: localDir,
    ephemeral: false,
    reason: `neither ${localDir} nor ${ephemeralDir} supports atomic rename (${ephemeralProbe.detail ?? "unknown error"})`,
    storageDetail: localKind.detail,
  };
}

/** True when the error is LanceDB rejecting an unsupported filesystem. */
export function isUnsupportedLanceCommitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("does not support an operation required for safe lance commits")
    || (lower.includes("atomic rename") && lower.includes("not supported"))
    || lower.includes("mountpoint for amazon s3");
}
