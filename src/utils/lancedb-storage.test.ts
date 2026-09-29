import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStoragePath,
  findMountForPath,
  isUnsupportedLanceCommitError,
  probeAtomicRenameSupport,
  resolveLanceDbStorageDir,
  type AtomicRenameProbeResult,
  type StorageKind,
} from "./lancedb-storage";

const supported: AtomicRenameProbeResult = { supported: true };
const unsupported: AtomicRenameProbeResult = { supported: false, detail: "EINVAL: invalid argument" };
const local: StorageKind = { nonLocal: false, detail: "/ (overlay)" };
const objectStorage: StorageKind = { nonLocal: true, detail: "/app/data (fuse.mountpoint-s3)" };

describe("probeAtomicRenameSupport", () => {
  test("reports a real local directory as supported and cleans up its probes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lance-probe-"));
    try {
      const result = probeAtomicRenameSupport(dir);
      expect(result.supported).toBe(true);
      // Probe files must not be left behind.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findMountForPath / classifyStoragePath", () => {
  function withMounts(contents: string, fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "lance-mounts-"));
    const mountsPath = join(dir, "mounts");
    writeFileSync(mountsPath, contents, "utf8");
    try {
      fn(mountsPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("selects the longest matching mount point", () => {
    withMounts(
      [
        "overlay / overlay rw 0 0",
        "bucket /app/data fuse.mountpoint-s3 rw 0 0",
        "other /app/apple ext4 rw 0 0",
      ].join("\n"),
      (mountsPath) => {
        expect(findMountForPath("/app/data/lancedb", mountsPath)?.fsType).toBe("fuse.mountpoint-s3");
        expect(findMountForPath("/app/frontend/dist", mountsPath)?.fsType).toBe("overlay");
      },
    );
  });

  test("classifies FUSE / object-storage mounts as non-local", () => {
    withMounts("bucket /app/data fuse.mountpoint-s3 rw 0 0\noverlay / overlay rw 0 0", (mountsPath) => {
      expect(classifyStoragePath("/app/data/lancedb", mountsPath).nonLocal).toBe(true);
      expect(classifyStoragePath("/app/runtime-data/lancedb", mountsPath).nonLocal).toBe(false);
    });
  });

  test("treats an unreadable mount table as local (never a hard failure)", () => {
    const kind = classifyStoragePath("/app/data/lancedb", "/nonexistent/mounts");
    expect(kind.nonLocal).toBe(false);
    expect(kind.detail).toContain("unavailable");
  });
});

describe("resolveLanceDbStorageDir", () => {
  test("keeps <dataDir>/lancedb when it is local and commit-capable", () => {
    const dataDir = "/var/lib/lumiverse";
    const resolution = resolveLanceDbStorageDir({
      dataDir,
      probe: () => supported,
      classify: () => local,
    });
    expect(resolution.dir).toBe(join(dataDir, "lancedb"));
    expect(resolution.ephemeral).toBe(false);
  });

  test("relocates when the mount is object storage even if the rename probe passes", () => {
    // The production failure mode: Mountpoint-for-S3 accepts the rename syscall
    // but cannot commit a Lance transaction, so the probe alone is not enough.
    const dataDir = "/app/data";
    const resolution = resolveLanceDbStorageDir({
      dataDir,
      runtimeDir: "/app/runtime-data",
      probe: () => supported,
      classify: (dir) => (dir.startsWith(dataDir) ? objectStorage : local),
    });
    expect(resolution.ephemeral).toBe(true);
    expect(resolution.dir).toBe("/app/runtime-data/lancedb");
    expect(resolution.reason).toContain("object-storage");
  });

  test("relocates when the rename probe fails", () => {
    const dataDir = "/app/data";
    const resolution = resolveLanceDbStorageDir({
      dataDir,
      runtimeDir: "/app/runtime-data",
      probe: (dir) => (dir.startsWith(dataDir) ? unsupported : supported),
      classify: () => local,
    });
    expect(resolution.ephemeral).toBe(true);
    expect(resolution.dir).toBe("/app/runtime-data/lancedb");
  });

  test("default production config resolves LanceDB OUTSIDE the persistent DATA_DIR", () => {
    // DATA_DIR (/app/data) is an object-storage mount; no LUMIVERSE_RUNTIME_DIR
    // is set. The default must land on the in-container local runtime dir, never
    // back under DATA_DIR — this is the acceptance criterion for production.
    const dataDir = "/app/data";
    const resolution = resolveLanceDbStorageDir({
      dataDir,
      probe: (dir) => ({ supported: !dir.startsWith(dataDir) }),
      classify: (dir) => (dir.startsWith(dataDir) ? objectStorage : local),
    });
    expect(resolution.ephemeral).toBe(true);
    expect(resolution.dir).toBe("/app/runtime-data/lancedb");
    expect(resolution.dir.startsWith(dataDir)).toBe(false);
  });

  test("honors an explicit operator override without relocating", () => {
    let classified = false;
    const resolution = resolveLanceDbStorageDir({
      dataDir: "/app/data",
      configuredDir: "/mnt/fast/lance",
      probe: () => supported,
      classify: () => { classified = true; return local; },
    });
    expect(classified).toBe(true);
    expect(resolution.dir).toBe("/mnt/fast/lance");
    expect(resolution.ephemeral).toBe(false);
  });

  test("falls back to the configured directory when nothing can commit", () => {
    const resolution = resolveLanceDbStorageDir({
      dataDir: "/app/data",
      runtimeDir: "/app/runtime-data",
      probe: () => unsupported,
      classify: () => local,
    });
    expect(resolution.ephemeral).toBe(false);
    expect(resolution.dir).toBe("/app/data/lancedb");
    expect(resolution.reason).toContain("neither");
  });
});

describe("isUnsupportedLanceCommitError", () => {
  test("matches LanceDB's unsupported-filesystem message", () => {
    expect(isUnsupportedLanceCommitError(
      new Error("the filesystem does not support an operation required for safe Lance commits"),
    )).toBe(true);
  });

  test("matches a Mountpoint-for-S3 complaint", () => {
    expect(isUnsupportedLanceCommitError(
      new Error("Mountpoint for Amazon S3 does not support rename"),
    )).toBe(true);
  });

  test("does not match ordinary write conflicts", () => {
    expect(isUnsupportedLanceCommitError(new Error("Commit conflict: concurrent write detected"))).toBe(false);
    expect(isUnsupportedLanceCommitError(new Error("reserve commit"))).toBe(false);
    expect(isUnsupportedLanceCommitError(undefined)).toBe(false);
  });
});
