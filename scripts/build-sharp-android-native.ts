#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { androidNdkLlvm, nativeSha256, sharpAndroidLibraries, walkNativeNotices } from "./android-native";

const root = resolve(import.meta.dir, "..");
const cache = join(root, ".tmp/android-native");
const ndk = process.env.ANDROID_NDK_HOME || join(cache, "android-ndk-r28c");
const llvm = androidNdkLlvm(ndk);
const sysroot = join(cache, "termux-sysroot");
const prefix = join(sysroot, "data/data/com.termux/files/usr");
const downloads = join(cache, "downloads"); mkdirSync(downloads, { recursive: true });
const lock = await Bun.file(join(root, "android/native/termux-aarch64.json")).json() as {
  repository: string; packages: Array<{ Package: string; Version: string; Filename: string; SHA256: string }>;
};
async function run(cmd: string[], cwd = root) {
  const child = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Build failed: ${cmd.join(" ")}`);
}
async function download(url: string, path: string, sha256?: string) {
  if (!existsSync(path)) await run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--output", path, url]);
  if (sha256 && createHash("sha256").update(readFileSync(path)).digest("hex") !== sha256) throw new Error(`Checksum mismatch: ${path}`);
}
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < lock.packages.length) {
    const pkg = lock.packages[next++]!;
    await download(lock.repository + pkg.Filename, join(downloads, pkg.Filename.split("/").at(-1)!), pkg.SHA256);
  }
}));
mkdirSync(sysroot, { recursive: true });
for (const pkg of lock.packages) {
  const path = join(downloads, pkg.Filename.split("/").at(-1)!);
  const unpacked = join(cache, "deb", pkg.Package);
  if (existsSync(join(unpacked, ".complete")) && readFileSync(join(unpacked, ".complete"), "utf8") === pkg.SHA256) continue;
  mkdirSync(unpacked, { recursive: true });
  await run(["tar", "-xf", path, "-C", unpacked]);
  const archive = readdirSync(unpacked).find(name => name.startsWith("data.tar."));
  if (!archive) throw new Error(`Missing data archive: ${pkg.Package}`);
  await run(["tar", "-xf", join(unpacked, archive), "-C", sysroot]);
  writeFileSync(join(unpacked, ".complete"), pkg.SHA256);
}
console.log("[android-native] Android libvips dependencies extracted and verified.");
// Node-API is stable across Node/Bun versions. Only headers are used; no Node runtime is bundled.
const headers = join(cache, "node-headers"); mkdirSync(headers, { recursive: true });
for (const [name, hash] of Object.entries({
  "node_api.h": "d14db85d16f182045c42745a6e44b96e932dfe6e3bfcaac7a1096fae8412c579",
  "node_api_types.h": "8d5d854088d5725fec9775510e0aeeeb790a41ad083c49bb721d950b86e6bd61",
  "js_native_api.h": "048b4efdcd823f30afd323d61c8aba5be285077f9d790feb52a6fa6382df2541",
  "js_native_api_types.h": "0410c31e227f81e2981363c4d543f4832ac3df785343ec64cee621742ff8a034",
})) {
  await download(`https://raw.githubusercontent.com/nodejs/node/v24.0.0/src/${name}`, join(headers, name), hash);
}
const addon = join(cache, "node-addon-api");
const addonArchive = join(downloads, "node-addon-api-8.5.0.tgz");
await download("https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.5.0.tgz", addonArchive,
  "d12f07c8162283b6213551855f1da8dac162331374629830b5e640f130f07910");
if (!existsSync(join(addon, "napi.h"))) {
  mkdirSync(addon, { recursive: true });
  await run(["tar", "-xf", addonArchive, "--strip-components=1", "-C", addon]);
}
// The pinned Termux WebP package predates 16 KiB alignment. Rebuild the same ABI with NDK r28c.
const webpArchive = join(downloads, "libwebp-1.6.0.tar.gz");
await download("https://github.com/webmproject/libwebp/archive/refs/tags/v1.6.0.tar.gz", webpArchive,
  "93a852c2b3efafee3723efd4636de855b46f9fe1efddd607e1f42f60fc8f2136");
const webpSource = join(cache, "libwebp-source"), webpBuild = join(cache, "libwebp-build");
mkdirSync(webpSource, { recursive: true });
await run(["tar", "-xf", webpArchive, "--strip-components=1", "-C", webpSource]);
await run(["cmake", "-S", webpSource, "-B", webpBuild, `-DCMAKE_TOOLCHAIN_FILE=${join(ndk, "build/cmake/android.toolchain.cmake")}`,
  "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-29", "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",
  "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=ON", "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384",
  ...["ANIM_UTILS", "CWEBP", "DWEBP", "GIF2WEBP", "IMG2WEBP", "VWEBP", "WEBPINFO", "WEBPMUX", "EXTRAS"].map(name => `-DWEBP_BUILD_${name}=OFF`),
  "-DWEBP_BUILD_LIBWEBPMUX=ON", "-DWEBP_ENABLE_SWAP_16BIT_CSP=ON"]);
await run(["cmake", "--build", webpBuild, "--parallel", "4"]);
// Preserve filenames required by the other pinned libraries; SONAMEs are handled by the packager.
for (const name of ["libwebp.so", "libwebpdemux.so", "libwebpmux.so", "libsharpyuv.so"]) {
  const bytes = readFileSync(join(webpBuild, name));
  writeFileSync(join(prefix, "lib", name), bytes);
}
const sharp = join(root, "node_modules/sharp");
const sharpVersion = (await Bun.file(join(sharp, "package.json")).json()).version;
if (sharpVersion !== "0.34.5") throw new Error("Update the Android Sharp build pin.");
const out = join(root, "dist/native/android-arm64"); mkdirSync(out, { recursive: true });
const binary = join(out, "libsharp.so");
await run([join(llvm, "aarch64-linux-android29-clang++"), "-shared", "-fPIC", "-std=c++17", "-O2", "-fexceptions",
  "-DNAPI_VERSION=9", "-DNAPI_CPP_EXCEPTIONS", "-DNODE_ADDON_API_DISABLE_DEPRECATED", "-DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS",
  "-DSHARP_USE_GLOBAL_LIBVIPS", "-DG_DISABLE_ASSERT", "-DG_DISABLE_CAST_CHECKS", "-DG_DISABLE_CHECKS",
  `-I${headers}`, `-I${addon}`, `-I${join(prefix, "include")}`, `-I${join(prefix, "include/glib-2.0")}`, `-I${join(prefix, "lib/glib-2.0/include")}`,
  ...["common", "metadata", "stats", "operations", "pipeline", "utilities", "sharp"].map(name => join(sharp, "src", `${name}.cc`)),
  `-L${join(prefix, "lib")}`, "-lvips-cpp", "-lvips", "-lgobject-2.0", "-lglib-2.0", "-lc++_shared",
  "-Wl,-z,max-page-size=16384", "-Wl,-z,common-page-size=16384", "-Wl,-soname,libsharp.so", "-o", binary]);
await run([join(llvm, "llvm-strip"), "--strip-debug", binary]);
copyFileSync(join(sharp, "LICENSE"), join(out, "Sharp.LICENSE"));
const libraries = sharpAndroidLibraries(out, prefix);
const libdir = join(out, "sharp-libs"); mkdirSync(libdir, { recursive: true });
for (const library of libraries) writeFileSync(join(libdir, library.name), library.bytes);
const notices = join(out, "notices"); mkdirSync(notices, { recursive: true });
await download("https://raw.githubusercontent.com/libvips/libvips/v8.18.7/LICENSE", join(cache, "libvips-LICENSE"),
  "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551");
copyFileSync(join(cache, "libvips-LICENSE"), join(notices, "libvips.LICENSE"));
copyFileSync(join(addon, "LICENSE.md"), join(notices, "node-addon-api.LICENSE"));
copyFileSync(join(webpSource, "COPYING"), join(notices, "WebP.LICENSE"));
for (const notice of walkNativeNotices(join(prefix, "share/doc"))) {
  const destination = join(notices, notice.name); mkdirSync(resolve(destination, ".."), { recursive: true });
  copyFileSync(notice.path, destination);
}
copyFileSync(join(root, "android/native/termux-aarch64.json"), join(notices, "termux-packages.json"));
await Bun.write(join(out, "sharp.json"), JSON.stringify({ format: 1, version: sharpVersion, libvips: "8.18.7-1", target: "aarch64-linux-android", api: 29,
  sha256: nativeSha256(readFileSync(binary)), webp: "1.6.0", modules: ["heif", "jxl"],
  libraries: libraries.map(({ name, sha256, sourceSha256, needed }) => ({ name, sha256, sourceSha256, needed })) }, null, 2) + "\n");
console.log(`[android-native] Built ${binary}`);
