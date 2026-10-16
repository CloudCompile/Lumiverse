#!/usr/bin/env bun
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { androidNdkLlvm, nativeSha256, readAndroidElf } from "./android-native";

export async function buildAndroidBunCompat(out = resolve(import.meta.dir, "../dist/native/android-arm64")) {
  const root = resolve(import.meta.dir, "..");
  const llvm = androidNdkLlvm(process.env.ANDROID_NDK_HOME || join(root, ".tmp/android-native/android-ndk-r28c"));
  mkdirSync(out, { recursive: true });
  const name = "libbuninstallcompat.so";
  const source = join(root, "android/native/bun-install-compat.c");
  const child = Bun.spawn([join(llvm, "aarch64-linux-android29-clang"), "-shared", "-fPIC", "-std=c11", "-O2",
    "-Wall", "-Wextra", "-Werror", "-Wl,-z,max-page-size=16384", `-Wl,-soname,${name}`,
    source, "-ldl", "-o", join(out, name)], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Android Bun install compatibility build failed");
  const bytes = readFileSync(join(out, name));
  readAndroidElf(bytes);
  const manifest = { format: 1, target: "aarch64-linux-android", bunVersion: "1.4.2", library: name,
    sha256: nativeSha256(bytes), sourceSha256: nativeSha256(readFileSync(source)) };
  await Bun.write(join(out, "bun-install-compat.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, bytes };
}

if (import.meta.main) await buildAndroidBunCompat();
