#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { patchAndroidObjectStore } from "./patch-android-object-store";
import { androidNdkLlvm } from "./android-native";

const root = resolve(import.meta.dir, "..");
const version = "0.37.1";
const commit = "b89f87f206abd79a069833cee01f0c029ddb1397";
const target = "aarch64-linux-android";
const cache = join(root, ".tmp/android-native");
const ndk = process.env.ANDROID_NDK_HOME || join(cache, "android-ndk-r28c");
const llvm = androidNdkLlvm(ndk);
if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@lancedb/lancedb"] !== version)
  throw new Error("Update the Android LanceDB source pin to match package.json.");
async function run(cmd: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Build failed: ${cmd.join(" ")}`);
}
const source = join(cache, "lancedb-source");
if (!existsSync(source)) {
  let upstream = join(root, "vendor/lancedb-android/upstream/lancedb");
  if (!existsSync(upstream)) {
    upstream = join(cache, "lancedb-upstream");
    mkdirSync(cache, { recursive: true });
    if (!existsSync(upstream)) await run(["git", "clone", "--depth", "1", "--branch", `v${version}`, "https://github.com/lancedb/lancedb.git", upstream], root);
  }
  const archive = Bun.spawnSync(["git", "archive", commit], { cwd: upstream, stdout: "pipe", stderr: "pipe" });
  if (archive.exitCode) throw new Error(archive.stderr.toString());
  mkdirSync(source, { recursive: true });
  await new Bun.Archive(archive.stdout).extract(source);
  writeFileSync(join(source, ".source-commit"), commit);
}
if (readFileSync(join(source, ".source-commit"), "utf8") !== commit) throw new Error("Unexpected cached LanceDB source.");
// Vendor only this build's object_store. Never modify the global Cargo cache.
const objectStoreArchive = join(cache, "object_store-0.13.2.crate");
if (!existsSync(objectStoreArchive)) await run(["curl", "--fail", "--location", "--silent", "--show-error", "--output", objectStoreArchive,
  "https://static.crates.io/crates/object_store/object_store-0.13.2.crate"], root);
if (createHash("sha256").update(readFileSync(objectStoreArchive)).digest("hex") !== "622acbc9100d3c10e2ee15804b0caa40e55c933d5aa53814cd520805b7958a49")
  throw new Error("object_store source checksum mismatch");
const originalObjectStore = join(cache, "object-store-original"); mkdirSync(originalObjectStore, { recursive: true });
await run(["tar", "-xf", objectStoreArchive, "--strip-components=1", "-C", originalObjectStore], root);
const patchedStore = join(cache, "object-store");
const objectStorePatch = patchAndroidObjectStore(originalObjectStore, patchedStore, join(root, "android/native/object-store-android.rs"));
const workspaceManifest = join(source, "Cargo.toml");
if (!readFileSync(workspaceManifest, "utf8").includes("[patch.crates-io.object_store]"))
  writeFileSync(workspaceManifest, readFileSync(workspaceManifest, "utf8") + `\n[patch.crates-io.object_store]\npath = ${JSON.stringify(patchedStore)}\n`);
await run(["cargo", "+1.97.0", "update", "-p", "object_store", "--offline"], source);
const env = {
  ...process.env,
  CARGO_TARGET_DIR: join(cache, "lancedb-target"),
  CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: join(llvm, "aarch64-linux-android29-clang"),
  CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS: "-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384",
  CC_aarch64_linux_android: join(llvm, "aarch64-linux-android29-clang"),
  CXX_aarch64_linux_android: join(llvm, "aarch64-linux-android29-clang++"),
  AR_aarch64_linux_android: join(llvm, "llvm-ar"),
  CARGO_PROFILE_RELEASE_LTO: "off",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
  CARGO_PROFILE_RELEASE_OPT_LEVEL: "2",
  CARGO_PROFILE_RELEASE_DEBUG: "0",
  CARGO_PROFILE_RELEASE_STRIP: "none",
  CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP: "none",
  CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_DEBUG: "1",
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "4",
  CARGO_INCREMENTAL: "0",
};
await run(["cargo", "+1.97.0", "build", "--manifest-path", join(source, "nodejs/Cargo.toml"), "--locked", "--release", "--target", target,
  "--no-default-features", "--features", "remote,lancedb/metrics-otel"], source, env);
const out = join(root, "dist/native/android-arm64"); mkdirSync(out, { recursive: true });
const binary = join(out, "liblancedb.so");
copyFileSync(join(cache, "lancedb-target", target, "release/liblancedb_nodejs.so"), binary);
await run([join(llvm, "llvm-strip"), "--strip-unneeded", binary], root);
copyFileSync(join(source, "LICENSE"), join(out, "LanceDB.LICENSE"));
const notices = join(out, "notices"); mkdirSync(notices, { recursive: true });
copyFileSync(join(patchedStore, "LICENSE.txt"), join(notices, "object_store.LICENSE"));
copyFileSync(join(source, "Cargo.lock"), join(out, "lancedb.Cargo.lock"));
await Bun.write(join(out, "lancedb.json"), JSON.stringify({ format: 1, version, sourceCommit: commit, target, api: 29, rustToolchain: "1.97.0",
  features: ["remote", "lancedb/metrics-otel"], objectStore: "0.13.2", objectStorePatch,
  sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }, null, 2) + "\n");
console.log(`[android-native] Built ${binary}`);
