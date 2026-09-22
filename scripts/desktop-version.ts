#!/usr/bin/env bun
/**
 * Lumiverse Desktop version bump.
 *
 * Run with: bun run desktop:version <version>
 *
 * Sets the desktop version in the three manifests that must move together
 * (desktop/package.json, desktop/src-tauri/Cargo.toml,
 * desktop/src-tauri/tauri.conf.json), then runs `bun run desktop:lock` so
 * Cargo rewrites the lumiverse-tray entry in Cargo.lock. The lockfile is
 * never hand-edited; cargo is its only writer.
 *
 * All three manifests are read and transformed before the first write, so a
 * missing or malformed manifest aborts the run without leaving a partial
 * bump behind.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { printBanner, theme } from "./ui";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The version-bearing manifests, bumped together. */
const MANIFESTS = [
  "desktop/package.json",
  "desktop/src-tauri/Cargo.toml",
  "desktop/src-tauri/tauri.conf.json",
] as const;

const LOCKFILE = "desktop/src-tauri/Cargo.lock";
const CRATE_NAME = "lumiverse-tray";

// Same loose semver the release script accepts (scripts/release.sh).
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/;

function die(message: string): never {
  console.error(`  ${theme.warning}✗${theme.reset} ${message}`);
  process.exit(1);
}

const USAGE = [
  "Usage: bun run desktop:version <version>",
  "",
  "Bumps the Lumiverse Desktop version in all three manifests, then",
  "refreshes Cargo.lock via `bun run desktop:lock`:",
  "",
  "  desktop/package.json",
  "  desktop/src-tauri/Cargo.toml",
  "  desktop/src-tauri/tauri.conf.json",
  "  desktop/src-tauri/Cargo.lock   (via cargo, never hand-edited)",
  "",
  "Examples:",
  "  bun run desktop:version 0.3.0",
  "  bun run desktop:version v0.3.0-beta.1",
].join("\n");

async function readManifest(rel: string): Promise<string> {
  try {
    return await readFile(resolve(REPO_ROOT, rel), "utf8");
  } catch {
    die(`cannot read ${rel} — run this script from the repository checkout`);
  }
}

function bumpJson(source: string, version: string, rel: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    die(`${rel} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || typeof parsed.version !== "string") {
    die(`${rel} has no top-level "version" to bump`);
  }
  parsed.version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function bumpCargoToml(source: string, version: string): string {
  // Table-scoped so only [package] is touched, never a future [dependencies]
  // or [target] table that also grows a version-shaped key.
  let table = "";
  let replaced = false;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^\s*\[(.+)\]\s*$/);
    if (header) {
      table = header[1].trim();
      continue;
    }
    if (table !== "package" || replaced) continue;
    const field = lines[index].match(/^(\s*)version\s*=\s*"[^"]*"/);
    if (!field) continue;
    lines[index] = `${field[1]}version = "${version}"`;
    replaced = true;
  }
  if (!replaced) {
    die(`desktop/src-tauri/Cargo.toml has no "version" key in its [package] table`);
  }
  return lines.join("\n");
}

/** The locked version of the desktop crate, read back after `cargo update`. */
function crateVersionInLock(lockSource: string): string | null {
  for (const block of lockSource.split("[[package]]").slice(1)) {
    const name = block.match(/^name = "(.*)"$/m);
    const version = block.match(/^version = "(.*)"$/m);
    if (name && name[1] === CRATE_NAME && version) return version[1];
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    console.log(USAGE);
    return;
  }
  if (args.length !== 1) {
    console.error(`desktop:version: expected exactly one version argument, got ${args.length === 0 ? "none" : args.map((arg) => `'${arg}'`).join(" ")}`);
    console.error(USAGE);
    process.exit(1);
  }

  const version = args[0].replace(/^v/, "");
  if (!VERSION_RE.test(version)) {
    die(`invalid version '${args[0]}' — expected X.Y.Z or X.Y.Z-suffix (e.g. 0.3.0, 0.3.0-beta.1)`);
  }

  printBanner("Desktop version bump");

  const sources = await Promise.all(MANIFESTS.map(readManifest));

  const updated = [
    bumpJson(sources[0], version, MANIFESTS[0]),
    bumpCargoToml(sources[1], version),
    bumpJson(sources[2], version, MANIFESTS[2]),
  ];

  for (const [index, rel] of MANIFESTS.entries()) {
    await writeFile(resolve(REPO_ROOT, rel), updated[index], "utf8");
    console.log(`  ${theme.success}✓${theme.reset} ${rel} → ${version}`);
  }

  console.log("");
  console.log(`  ${theme.secondary}►${theme.reset} Refreshing Cargo.lock (bun run desktop:lock)…`);
  const lock = Bun.spawn({
    cmd: [process.execPath, "run", "desktop:lock"],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await lock.exited) !== 0) {
    die("cargo update failed — is the Rust toolchain installed? (bun run desktop:doctor). The manifests are already updated; commit them only together with a refreshed Cargo.lock.");
  }

  const locked = crateVersionInLock(await readFile(resolve(REPO_ROOT, LOCKFILE), "utf8"));
  if (locked !== version) {
    die(`Cargo.lock still pins ${CRATE_NAME} at ${locked ?? "an unknown version"} instead of ${version}`);
  }

  console.log("");
  console.log(`  ${theme.success}Desktop version set to ${version}${theme.reset}`);
  console.log(`  ${theme.muted}Cargo.lock re-locked at ${version}. Commit the four changed files together.${theme.reset}`);
}

main();
