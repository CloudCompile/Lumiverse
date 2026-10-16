#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { collectAndroidLibraries, nativeSha256, relocateAndroidGitShell, walkNativeNotices } from "./android-native";

const root = resolve(import.meta.dir, ".."), cache = join(root, ".tmp/android-native");
// Keep this sysroot separate from the media builds so their pinned libraries cannot change.
const sysroot = join(cache, "git-sysroot"), prefix = join(sysroot, "data/data/com.termux/files/usr");
const downloads = join(cache, "downloads");
const lock = await Bun.file(join(root, "android/native/git-aarch64.json")).json() as {
  repository: string; packages: Array<{ Package: string; Version: string; Filename: string; SHA256: string }>;
};
async function run(cmd: string[]) {
  const child = Bun.spawn(cmd, { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Android Git preparation failed: ${cmd[0]}`);
}
mkdirSync(downloads, { recursive: true });
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < lock.packages.length) {
    const pkg = lock.packages[next++]!, path = join(downloads, pkg.Filename.split("/").at(-1)!);
    if (!existsSync(path)) await run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--output", path, lock.repository + pkg.Filename]);
    if (nativeSha256(readFileSync(path)) !== pkg.SHA256) throw new Error(`Android package checksum mismatch: ${pkg.Package}`);
  }
}));
mkdirSync(sysroot, { recursive: true });
for (const pkg of lock.packages) {
  const unpacked = join(cache, "git-deb", pkg.Package), complete = join(unpacked, ".complete");
  if (existsSync(complete) && readFileSync(complete, "utf8") === pkg.SHA256) continue;
  mkdirSync(unpacked, { recursive: true });
  await run(["tar", "-xf", join(downloads, pkg.Filename.split("/").at(-1)!), "-C", unpacked]);
  const archive = readdirSync(unpacked).find(name => name.startsWith("data.tar."));
  if (!archive) throw new Error(`Missing package archive: ${pkg.Package}`);
  await run(["tar", "-xf", join(unpacked, archive), "-C", sysroot]);
  writeFileSync(complete, pkg.SHA256);
}
const libraries = collectAndroidLibraries([
  { name: "libgit.so", path: join(prefix, "bin/git"), executable: true },
  { name: "libgitremotehttp.so", path: join(prefix, "libexec/git-core/git-remote-http"), executable: true },
], join(prefix, "lib"));
const out = join(root, "dist/native/android-arm64"), libdir = join(out, "git-libs");
mkdirSync(libdir, { recursive: true });
for (const library of libraries) {
  if (["libgit.so", "libgitremotehttp.so"].includes(library.name)) {
    library.bytes = relocateAndroidGitShell(library.bytes);
    library.sha256 = nativeSha256(library.bytes);
  }
  writeFileSync(join(libdir, library.name), library.bytes);
}
copyFileSync(join(prefix, "etc/tls/cert.pem"), join(out, "git-ca-bundle.pem"));
const notices = join(out, "notices"); mkdirSync(notices, { recursive: true });
for (const notice of walkNativeNotices(join(prefix, "share/doc"))) {
  const destination = join(notices, notice.name); mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(notice.path, destination);
}
copyFileSync(join(root, "android/native/git-aarch64.json"), join(notices, "git-packages.json"));
await Bun.write(join(out, "git.json"), JSON.stringify({ format: 1, version: lock.packages.find(pkg => pkg.Package === "git")!.Version,
  target: "aarch64-linux-android", license: "GPL-2.0-only", executable: "libgit.so", httpsHelper: "libgitremotehttp.so",
  caBundleSha256: nativeSha256(readFileSync(join(out, "git-ca-bundle.pem"))),
  libraries: libraries.map(({ name, sha256, sourceSha256, needed }) => ({ name, sha256, sourceSha256, needed })) }, null, 2) + "\n");
console.log(`[android-native] Prepared Git, its HTTPS helper, and ${libraries.length - 2} Android dependencies.`);
