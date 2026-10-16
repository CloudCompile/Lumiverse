import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdentityFileCorruptError,
  bytesToHex,
  createIdentityFile,
  hexToBytes,
  inspectIdentityFile,
  readIdentityFile,
  rebuildIdentityFile,
  resolveIdentity,
} from "./identity";

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiverse-identity-"));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Flip a byte inside the masked key so the HMAC integrity check fails. */
function corruptMaskedKey(path: string): void {
  const bytes = readFileSync(path);
  bytes[45] = bytes[45] ^ 0xff;
  writeFileSync(path, bytes);
}

describe("identity file reading", () => {
  test("round-trips a generated identity", async () => {
    const path = join(tempDir(), "lumiverse.identity");
    const written = await createIdentityFile(path);
    const read = await readIdentityFile(path);
    expect(bytesToHex(read)).toBe(bytesToHex(written));
  });

  test("flags a truncated file as corrupt rather than throwing a generic error", async () => {
    const path = join(tempDir(), "lumiverse.identity");
    await createIdentityFile(path);
    writeFileSync(path, readFileSync(path).subarray(0, 60));

    await expect(readIdentityFile(path)).rejects.toBeInstanceOf(IdentityFileCorruptError);
  });

  test("flags a failed integrity check as corrupt", async () => {
    const path = join(tempDir(), "lumiverse.identity");
    await createIdentityFile(path);
    corruptMaskedKey(path);

    await expect(readIdentityFile(path)).rejects.toBeInstanceOf(IdentityFileCorruptError);
  });
});

describe("identity file inspection", () => {
  test("returns null for a healthy file and a reason for a corrupt one", async () => {
    const dir = tempDir();
    const good = join(dir, "good.identity");
    await createIdentityFile(good);
    expect(await inspectIdentityFile(good)).toBeNull();

    const bad = join(dir, "bad.identity");
    await createIdentityFile(bad);
    writeFileSync(bad, "not an identity file");
    expect(await inspectIdentityFile(bad)).toContain("expected 104");
  });

  test("returns null when the file is absent", async () => {
    expect(await inspectIdentityFile(join(tempDir(), "missing.identity"))).toBeNull();
  });
});

describe("identity file rebuild", () => {
  test("quarantines the corrupt file and reuses ENCRYPTION_KEY", async () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.identity");
    const original = await createIdentityFile(path);
    corruptMaskedKey(path);

    const result = await rebuildIdentityFile(path, bytesToHex(original));

    expect(result.rebuiltFromEnvKey).toBe(true);
    expect(result.quarantinedPath).not.toBeNull();
    expect(existsSync(result.quarantinedPath!)).toBe(true);
    // The recovered key matches the original, so existing secrets still decrypt.
    expect(bytesToHex(await readIdentityFile(path))).toBe(bytesToHex(original));
  });

  test("generates a fresh key when no ENCRYPTION_KEY is available", async () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.identity");
    const original = await createIdentityFile(path);
    corruptMaskedKey(path);

    const result = await rebuildIdentityFile(path, "");

    expect(result.rebuiltFromEnvKey).toBe(false);
    expect(result.quarantinedPath).not.toBeNull();
    expect(bytesToHex(await readIdentityFile(path))).not.toBe(bytesToHex(original));
  });
});

describe("identity resolution recovery", () => {
  test("recovers from a corrupt file instead of failing startup", async () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.identity");
    await createIdentityFile(path);
    corruptMaskedKey(path);

    const resolved = await resolveIdentity(path, "");

    expect(resolved.source).toBe("recovered");
    expect(resolved.key.length).toBe(32);
    // The replacement file is valid on the next boot.
    expect(await inspectIdentityFile(path)).toBeNull();
  });

  test("still uses a healthy file unchanged", async () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.identity");
    const key = await createIdentityFile(path);

    const resolved = await resolveIdentity(path, "");

    expect(resolved.source).toBe("file");
    expect(resolved.keyHex).toBe(bytesToHex(key));
  });

  test("migrates ENCRYPTION_KEY when no identity file exists", async () => {
    const dir = tempDir();
    const path = join(dir, "lumiverse.identity");
    const keyHex = bytesToHex(hexToBytes("ab".repeat(32)));

    const resolved = await resolveIdentity(path, keyHex);

    expect(resolved.source).toBe("env-migrated");
    expect(resolved.keyHex).toBe(keyHex);
    expect(existsSync(path)).toBe(true);
  });
});
