import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isUnsupportedLanceCommitError,
  probeAtomicRenameSupport,
  resolveLanceDbStorageDir,
  type AtomicRenameProbeResult,
} from "./lancedb-storage";

const supported: AtomicRenameProbeResult = { supported: true };
const unsupported: AtomicRenameProbeResult = { supported: false, detail: "EXDEV: cross-device link" };

describe("probeAtomicRenameSupport", () => {
  test("reports a real local directory as supported and cleans up its probes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lance-probe-"));
    try {
      const result = probeAtomicRenameSupport(dir);
      expect(result.supported).toBe(true);
      // Probe files must not be left behind.
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveLanceDbStorageDir", () => {
  test("keeps <dataDir>/lancedb when it supports atomic rename", () => {
    const dataDir = "/var/lib/lumiverse";
    const resolution = resolveLanceDbStorageDir({
      dataDir,
      probe: () => supported,
    });
    expect(resolution).toEqual({ dir: join(dataDir, "lancedb"), ephemeral: false });
  });

  test("relocates to ephemeral local disk when <dataDir>/lancedb cannot commit", () => {
    const dataDir = "/app/data";
    const ephemeralRoot = "/tmp";
    let probeCount = 0;
    const resolution = resolveLanceDbStorageDir({
      dataDir,
      ephemeralRoot,
      probe: (dir) => {
        probeCount += 1;
        // The object-storage mount fails; local temp disk succeeds.
        return dir.startsWith(dataDir) ? unsupported : supported;
      },
    });
    expect(probeCount).toBe(2);
    expect(resolution.ephemeral).toBe(true);
    expect(resolution.dir).toBe(join(ephemeralRoot, "lumiverse-lancedb"));
    expect(resolution.reason).toContain(join(dataDir, "lancedb"));
  });

  test("honors an explicit operator override without probing", () => {
    let probed = false;
    const resolution = resolveLanceDbStorageDir({
      dataDir: "/app/data",
      configuredDir: "/mnt/fast/lance",
      probe: () => { probed = true; return unsupported; },
    });
    expect(probed).toBe(false);
    expect(resolution).toEqual({ dir: "/mnt/fast/lance", ephemeral: false });
  });

  test("falls back to the configured directory when no local path can commit", () => {
    const resolution = resolveLanceDbStorageDir({
      dataDir: "/app/data",
      ephemeralRoot: "/tmp",
      probe: () => unsupported,
    });
    expect(resolution.ephemeral).toBe(false);
    expect(resolution.dir).toBe(join("/app/data", "lancedb"));
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