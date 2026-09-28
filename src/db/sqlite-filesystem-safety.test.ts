import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  __testing,
  describeFilesystemType,
  isNetworkOrObjectFilesystemType,
  probeWalSupport,
  readFilesystemType,
  resolveSqliteJournalMode,
  type FilesystemTypeProbe,
} from "./sqlite-filesystem-safety";

beforeEach(() => __testing.clearResolutionCache());

const NFS_MAGIC = 0x6969;
const FUSE_MAGIC = 0x65735546;
const EXT4_MAGIC = 0xef53;

function typeProbe(type: number, name = "stub"): FilesystemTypeProbe {
  return { type, name };
}

describe("network/object filesystem detection", () => {
  test("classifies NFS, FUSE, SMB and friends as unsafe for WAL", () => {
    expect(isNetworkOrObjectFilesystemType(NFS_MAGIC)).toBe(true);
    expect(isNetworkOrObjectFilesystemType(FUSE_MAGIC)).toBe(true);
    expect(isNetworkOrObjectFilesystemType(0xff534d42)).toBe(true); // CIFS
    expect(isNetworkOrObjectFilesystemType(0x01021997)).toBe(true); // 9p
    expect(describeFilesystemType(NFS_MAGIC)).toBe("NFS");
    expect(describeFilesystemType(FUSE_MAGIC)).toBe("FUSE");
  });

  test("treats local block-device filesystems as safe", () => {
    expect(isNetworkOrObjectFilesystemType(EXT4_MAGIC)).toBe(false);
    expect(describeFilesystemType(EXT4_MAGIC)).toBe("0xef53");
  });

  test("reads the filesystem type of a real local directory", () => {
    const probe = readFilesystemType(".");
    expect(probe).not.toBeNull();
    expect(typeof probe!.type).toBe("number");
    // The workspace/dev checkout is a local filesystem, not a network mount.
    expect(isNetworkOrObjectFilesystemType(probe!.type)).toBe(false);
  });

  test("probeWalSupport confirms WAL works on a real local directory", () => {
    const result = probeWalSupport(".");
    expect(result.supported).toBe(true);
    expect(result.detail).toBe("journal_mode=wal");
  });

  test("probeWalSupport leaves no probe files behind", () => {
    probeWalSupport("/tmp");
    const leftovers = readdirSync("/tmp").filter((name) =>
      name.startsWith(".lumiverse-wal-probe-"),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("resolveSqliteJournalMode", () => {
  test("uses WAL on a local filesystem where the WAL probe succeeds", () => {
    const result = resolveSqliteJournalMode({
      dir: "/tmp",
      readType: () => typeProbe(EXT4_MAGIC),
      probeWal: () => ({ supported: true, detail: "journal_mode=wal" }),
    });
    expect(result.mode).toBe("WAL");
    expect(result.reason).toBeUndefined();
  });

  test("falls back to DELETE on a network/object-storage mount", () => {
    const result = resolveSqliteJournalMode({
      dir: "/data",
      readType: () => typeProbe(NFS_MAGIC, "NFS"),
      probeWal: () => ({ supported: true, detail: "journal_mode=wal" }),
    });
    expect(result.mode).toBe("DELETE");
    expect(result.reason).toContain("NFS");
  });

  test("falls back to DELETE when WAL cannot actually be enabled", () => {
    const result = resolveSqliteJournalMode({
      dir: "/data",
      readType: () => typeProbe(EXT4_MAGIC),
      probeWal: () => ({ supported: false, detail: "disk I/O error" }),
    });
    expect(result.mode).toBe("DELETE");
    expect(result.reason).toContain("disk I/O error");
  });

  test("respects an explicit operator override in either direction", () => {
    expect(
      resolveSqliteJournalMode({
        dir: "/data",
        override: "wal",
        readType: () => typeProbe(NFS_MAGIC, "NFS"),
        probeWal: () => ({ supported: false }),
      }).mode,
    ).toBe("WAL");

    expect(
      resolveSqliteJournalMode({
        dir: "/tmp",
        override: "delete",
        readType: () => typeProbe(EXT4_MAGIC),
        probeWal: () => ({ supported: true }),
      }).mode,
    ).toBe("DELETE");
  });

  test("ignores an unrecognized override and falls through to detection", () => {
    const result = resolveSqliteJournalMode({
      dir: "/tmp",
      override: "vacuum",
      readType: () => typeProbe(EXT4_MAGIC),
      probeWal: () => ({ supported: true }),
    });
    expect(result.mode).toBe("WAL");
  });
});
