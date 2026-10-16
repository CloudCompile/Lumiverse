import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAndroidOwner } from "./setup";

const directories: string[] = [];
function folder() { const directory = mkdtempSync(join(tmpdir(), "lumiverse-android-setup-")); directories.push(directory); return directory; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("first-time setup saves credentials and the chosen extension storage budget", async () => {
  const directory = folder();
  await configureAndroidOwner(directory, 8123, { username: "androidowner", password: "android-test-password", extensionStorageMiB: "200" });
  expect(existsSync(join(directory, "owner.credentials"))).toBe(true);
  expect(JSON.parse(readFileSync(join(directory, "spindle/ephemeral-pools.json"), "utf8"))).toMatchObject({
    globalMaxBytes: 200 * 1024 * 1024, extensionDefaultMaxBytes: 20 * 1024 * 1024,
  });
});

test("invalid storage or credentials leave first-time setup available", async () => {
  for (const extensionStorageMiB of [undefined, "", "bad", 0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER]) {
    const directory = folder();
    await expect(configureAndroidOwner(directory, 8123, { username: "androidowner", password: "android-test-password", extensionStorageMiB })).rejects.toThrow("extension storage");
    expect(existsSync(join(directory, "owner.credentials"))).toBe(false);
  }
  const directory = folder();
  await expect(configureAndroidOwner(directory, 8123, { username: "x", password: "short", extensionStorageMiB: 500 })).rejects.toThrow("Username");
  expect(existsSync(join(directory, "spindle/ephemeral-pools.json"))).toBe(false);
});
