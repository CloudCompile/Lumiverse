#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { collectAndroidLibraries, nativeSha256, walkNativeNotices } from "./android-native";

const root = resolve(import.meta.dir, ".."), cache = join(root, ".tmp/android-native");
const downloads = join(cache, "downloads"), sysroot = join(cache, "termux-sysroot");
const prefix = join(sysroot, "data/data/com.termux/files/usr");
const lock = await Bun.file(join(root, "android/native/ffmpeg-aarch64.json")).json() as {
  repository: string; packages: Array<{ Package: string; Version: string; Filename: string; SHA256: string }>;
};
async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Android FFmpeg build failed: ${cmd[0]}`);
}
mkdirSync(downloads, { recursive: true });
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < lock.packages.length) {
    const pkg = lock.packages[next++]!, path = join(downloads, pkg.Filename.split("/").at(-1)!);
    if (!existsSync(path)) await run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--output", path, lock.repository + pkg.Filename]);
    if (nativeSha256(readFileSync(path)) !== pkg.SHA256) throw new Error(`Android package checksum mismatch: ${pkg.Package}`);
  }
}));
mkdirSync(sysroot, { recursive: true });
for (const pkg of lock.packages) {
  const unpacked = join(cache, "deb", pkg.Package), complete = join(unpacked, ".complete");
  if (existsSync(complete) && readFileSync(complete, "utf8") === pkg.SHA256) continue;
  mkdirSync(unpacked, { recursive: true });
  await run(["tar", "-xf", join(downloads, pkg.Filename.split("/").at(-1)!), "-C", unpacked]);
  const archive = readdirSync(unpacked).find(name => name.startsWith("data.tar."));
  if (!archive) throw new Error(`Missing package archive: ${pkg.Package}`);
  await run(["tar", "-xf", join(unpacked, archive), "-C", sysroot]);
  writeFileSync(complete, pkg.SHA256);
}
// Sharp's NDK-built WebP is shared with FFmpeg. Never reintroduce the old 4 KiB binaries.
if (!existsSync(join(root, "dist/native/android-arm64/sharp.json"))) throw new Error("Build Android Sharp first to prepare the aligned WebP libraries.");
const libraries = collectAndroidLibraries([
  { name: "libffmpeg.so", path: join(prefix, "bin/ffmpeg"), executable: true },
  { name: "libffprobe.so", path: join(prefix, "bin/ffprobe"), executable: true },
], join(prefix, "lib"));
const out = join(root, "dist/native/android-arm64"), libdir = join(out, "ffmpeg-libs"); mkdirSync(libdir, { recursive: true });
for (const library of libraries) writeFileSync(join(libdir, library.name), library.bytes);
const notices = join(out, "notices"); mkdirSync(notices, { recursive: true });
for (const name of ["FFmpeg.COPYING.GPLv3", "FFmpeg.NOTICE"])
  copyFileSync(join(root, "android/native/licenses", name), join(notices, name));
for (const notice of walkNativeNotices(join(prefix, "share/doc"))) {
  const destination = join(notices, notice.name); mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(notice.path, destination);
}
copyFileSync(join(root, "android/native/ffmpeg-aarch64.json"), join(notices, "ffmpeg-packages.json"));
await Bun.write(join(out, "ffmpeg.json"), JSON.stringify({ format: 1, version: lock.packages.find(pkg => pkg.Package === "ffmpeg")!.Version,
  target: "aarch64-linux-android", license: "GPL-3.0-or-later", executable: "libffmpeg.so", probe: "libffprobe.so",
  libraries: libraries.map(({ name, sha256, sourceSha256, needed }) => ({ name, sha256, sourceSha256, needed })) }, null, 2) + "\n");
console.log(`[android-native] Prepared FFmpeg/ffprobe and ${libraries.length - 2} Android dependencies.`);
