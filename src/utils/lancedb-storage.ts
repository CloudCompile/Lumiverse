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
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface AtomicRenameProbeResult {
  supported: boolean;
  /** Short, non-secret explanation when `supported` is false. */
  detail?: string;
}

/**
 * Probe whether `dir` supports the atomic rename (with overwrite) that LanceDB
 * needs for a safe manifest commit. Creates the directory if needed. Uses only
 * throwaway files and cleans them up.
 */
export function probeAtomicRenameSupport(dir: string): AtomicRenameProbeResult {
  const probeSource = join(dir, `.lancedb-commit-probe-${process.pid}.src`);
  const probeTarget = join(dir, `.lancedb-commit-probe-${process.pid}.dst`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { supported: false, detail: `cannot create directory: ${describeError(err)}` };
  }
  try {
    writeFileSync(probeTarget, "existing", "utf8");
    writeFileSync(probeSource, "replacement", "utf8");
    // Overwriting an existing file via rename is the operation LanceDB relies
    // on when it swaps a new manifest into place.
    renameSync(probeSource, probeTarget);
    return { supported: true };
  } catch (err) {
    return { supported: false, detail: describeError(err) };
  } finally {
    for (const path of [probeSource, probeTarget]) {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
    }
  }
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

export interface LanceDbStorageResolution {
  /** Effective directory that should back the LanceDB store. */
  dir: string;
  /** True when the store was moved off the configured directory. */
  ephemeral: boolean;
  /** Human-readable reason, present only when `ephemeral` is true. */
  reason?: string;
}

export interface ResolveLanceDbStorageDirOptions {
  dataDir: string;
  /** Explicit operator override (`LUMIVERSE_LANCEDB_DIR`). Wins when present. */
  configuredDir?: string | null;
  /** Ephemeral fallback root; defaults to the OS temp directory. */
  ephemeralRoot?: string;
  probe?: (dir: string) => AtomicRenameProbeResult;
}

export function resolveLanceDbStorageDir(options: ResolveLanceDbStorageDirOptions): LanceDbStorageResolution {
  const probe = options.probe ?? probeAtomicRenameSupport;
  const configured = options.configuredDir?.trim();
  // An explicit override is honored as-is. The operator asked for this path, so
  // we do not second-guess it — but we still report whether commits can land.
  if (configured) {
    return { dir: configured, ephemeral: false };
  }

  const localDir = join(options.dataDir, "lancedb");
  if (probe(localDir).supported) {
    return { dir: localDir, ephemeral: false };
  }

  const ephemeralRoot = options.ephemeralRoot ?? tmpdir();
  const ephemeralDir = join(ephemeralRoot, "lumiverse-lancedb");
  const ephemeralProbe = probe(ephemeralDir);
  if (ephemeralProbe.supported) {
    return {
      dir: ephemeralDir,
      ephemeral: true,
      reason: `${localDir} does not support atomic rename (LanceDB commit requirement)`,
    };
  }

  // Neither location supports Lance commits. Keep the configured directory so
  // behavior is unchanged, and let the caller surface the failure loudly.
  return {
    dir: localDir,
    ephemeral: false,
    reason: `neither ${localDir} nor ${ephemeralDir} supports atomic rename`,
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