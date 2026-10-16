#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { collectBundleFiles } from "./build-server";
import { androidSystemLibraries, nativeSha256, readAndroidElf, walkNativeNotices } from "./android-native";
import { buildAndroidBunCompat } from "./build-bun-android-compat";

const ROOT = resolve(import.meta.dir, "..");
export const ANDROID_BUN = {
  version: "1.4.2",
  archive: "bun-linux-aarch64-android.zip",
  sha256: "a1c7e2983f1bb65146beb256a4d72449f23042412bc2cf278aa6397ba27e0274",
};

/** Reject host or GNU Linux executables even when their CPU matches the APK. */
export function verifyAndroidBun(archive: Uint8Array): Uint8Array {
  if (createHash("sha256").update(archive).digest("hex") !== ANDROID_BUN.sha256)
    throw new Error("Android Bun archive checksum mismatch; use the pinned official release.");
  const binary = unzipSync(archive)["bun-linux-aarch64-android/bun"];
  if (!binary || binary[0] !== 0x7f || binary[1] !== 0x45 || binary[2] !== 0x4c || binary[3] !== 0x46 ||
    binary[4] !== 2 || binary[5] !== 1 || new DataView(binary.buffer, binary.byteOffset).getUint16(18, true) !== 183)
    throw new Error("Expected an Android ARM64 ELF executable.");
  if (!Buffer.from(binary).includes(Buffer.from("/system/bin/linker64")))
    throw new Error("Runtime does not use the Android linker.");
  return binary;
}

function newestDirectory(path: string, pattern: RegExp): string {
  const candidates = existsSync(path) ? readdirSync(path).filter(name => pattern.test(name)) : [];
  const selected = candidates.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  if (!selected) throw new Error(`Missing Android SDK component: ${path}`);
  return join(path, selected);
}

async function build() {
  const args = process.argv.slice(2);
  let skipFrontend = false, offline = false, runtimeOnly = false, prepareOnly = false;
  let nativeDir = join(ROOT, "dist/native/android-arm64");
  let bunZip = join(ROOT, ".tmp/android-prototype/bun-android.zip");
  let sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.HOME || "", "Library/Android/sdk");
  let javaHome = process.env.JAVA_HOME || "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--skip-frontend-build") skipFrontend = true;
    else if (args[i] === "--offline") offline = true;
    else if (args[i] === "--runtime-only") runtimeOnly = true;
    else if (args[i] === "--prepare-only") prepareOnly = true;
    else if (args[i] === "--native-dir" && args[i + 1]) nativeDir = resolve(args[++i]!);
    else if (args[i] === "--bun-zip" && args[i + 1]) bunZip = resolve(args[++i]!);
    else if (args[i] === "--sdk" && args[i + 1]) sdk = resolve(args[++i]!);
    else if (args[i] === "--java-home" && args[i + 1]) javaHome = resolve(args[++i]!);
    else throw new Error(`Unknown build option: ${args[i]}`);
  }
  const pkg = await Bun.file(join(ROOT, "package.json")).json();
  if (pkg.packageManager !== `bun@${ANDROID_BUN.version}` || Bun.version !== ANDROID_BUN.version)
    throw new Error(`This prototype is pinned to Bun ${ANDROID_BUN.version}; update its Android download and checksum when changing Bun.`);
  const tools = newestDirectory(join(sdk, "build-tools"), /^\d+\.\d+\.\d+$/);
  const platform = newestDirectory(join(sdk, "platforms"), /^android-\d+$/);
  const platformApi = Number(platform.match(/android-(\d+)$/)![1]);
  if (platformApi < 36) throw new Error("Install Android SDK platform 36 or newer.");
  const androidJar = join(platform, "android.jar");
  const env = { ...process.env, JAVA_HOME: javaHome, PATH: [join(javaHome, "bin"), process.env.PATH].join(process.platform === "win32" ? ";" : ":"),
    BUN_INSTALL_CACHE_DIR: join(ROOT, ".tmp/bun-cache"), TMPDIR: join(ROOT, ".tmp") };
  async function run(cmd: string[], cwd = ROOT) {
    const child = Bun.spawn(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error(`Build step failed: ${cmd[0]}`);
  }
  mkdirSync(join(ROOT, ".tmp/android-prototype"), { recursive: true });
  if (!existsSync(bunZip)) {
    if (offline) throw new Error(`Download ${ANDROID_BUN.archive} to ${bunZip} first, or build without --offline.`);
    mkdirSync(dirname(bunZip), { recursive: true });
    await run(["curl", "--fail", "--location", "--silent", "--show-error", "--output", bunZip,
      `https://github.com/oven-sh/bun/releases/download/bun-v${ANDROID_BUN.version}/${ANDROID_BUN.archive}`]);
  }
  const binary = verifyAndroidBun(readFileSync(bunZip));
  const installCompat = await buildAndroidBunCompat(nativeDir);
  const nativeFiles: Record<string, Uint8Array> = { [installCompat.library]: installCompat.bytes };
  const executableLibraries = new Set(["libffmpeg.so", "libffprobe.so", "libgit.so", "libgitremotehttp.so"]);
  let nativeDependencies: object | string = "not-included";
  if (!runtimeOnly) {
    if (!["sharp.json", "lancedb.json", "ffmpeg.json", "git.json"].every(name => existsSync(join(nativeDir, name))))
      throw new Error("Build native libraries with bun run build:android-native first, or select --runtime-only for runtime diagnostics.");
    const sharp = await Bun.file(join(nativeDir, "sharp.json")).json();
    const lance = await Bun.file(join(nativeDir, "lancedb.json")).json();
    const ffmpeg = await Bun.file(join(nativeDir, "ffmpeg.json")).json();
    const git = await Bun.file(join(nativeDir, "git.json")).json();
    const ffmpegLock = await Bun.file(join(ROOT, "android/native/ffmpeg-aarch64.json")).json();
    const gitLock = await Bun.file(join(ROOT, "android/native/git-aarch64.json")).json();
    if (sharp.version !== "0.34.5" || lance.version !== pkg.dependencies["@lancedb/lancedb"] ||
        ffmpeg.version !== ffmpegLock.packages.find((entry: { Package: string }) => entry.Package === "ffmpeg")?.Version ||
        git.version !== gitLock.packages.find((entry: { Package: string }) => entry.Package === "git")?.Version ||
        sharp.target !== "aarch64-linux-android" || lance.target !== "aarch64-linux-android" || ffmpeg.target !== "aarch64-linux-android" || git.target !== "aarch64-linux-android")
      throw new Error("Native library versions do not match this Android prototype.");
    if (nativeSha256(readFileSync(join(nativeDir, "git-ca-bundle.pem"))) !== git.caBundleSha256)
      throw new Error("Git certificate bundle checksum mismatch.");
    for (const library of [...sharp.libraries.map((entry: { name: string; sha256: string }) => ({ ...entry, path: join(nativeDir, "sharp-libs", entry.name) })),
      ...ffmpeg.libraries.map((entry: { name: string; sha256: string }) => ({ ...entry, path: join(nativeDir, "ffmpeg-libs", entry.name) })),
      ...git.libraries.map((entry: { name: string; sha256: string }) => ({ ...entry, path: join(nativeDir, "git-libs", entry.name) })),
      { name: "liblancedb.so", sha256: lance.sha256, path: join(nativeDir, "liblancedb.so") }]) {
      if (!/^lib[^/]+\.so$/.test(library.name)) throw new Error("Invalid APK library filename");
      const bytes = readFileSync(library.path), elf = readAndroidElf(bytes, { executable: executableLibraries.has(library.name) });
      if (nativeSha256(bytes) !== library.sha256) throw new Error(`Native checksum mismatch: ${library.name}`);
      if (elf.loads.some(segment => segment.alignment < 16384 || (segment.offset - segment.address) % 16384 !== 0))
        throw new Error(`Native library lacks 16 KiB alignment: ${library.name}`);
      if (elf.paths.some(path => path.text !== "$ORIGIN")) throw new Error(`Native search path is not relocatable: ${library.name}`);
      if (nativeFiles[library.name] && nativeSha256(nativeFiles[library.name]!) !== library.sha256)
        throw new Error(`Conflicting Android native dependency: ${library.name}`);
      nativeFiles[library.name] = bytes;
    }
    for (const [name, bytes] of Object.entries(nativeFiles)) for (const dependency of readAndroidElf(bytes, { executable: executableLibraries.has(name) }).needed)
      if (!androidSystemLibraries.has(dependency) && !nativeFiles[dependency]) throw new Error(`${name} requires missing ${dependency}`);
    nativeDependencies = { sharp: sharp.version, libvips: sharp.libvips, webp: sharp.webp, lancedb: lance.version, ffmpeg: ffmpeg.version, git: git.version,
      modules: sharp.modules, libraries: Object.entries(nativeFiles).map(([name, bytes]) => ({ name, sha256: nativeSha256(bytes) })) };
  }
  if (!skipFrontend) await run([process.execPath, "run", "build"], join(ROOT, "frontend"));
  if (!existsSync(join(ROOT, "frontend/dist/index.html"))) throw new Error("Build the frontend first.");
  const staging = mkdtempSync(join(ROOT, ".tmp/android-prototype/build-"));
  try {
    const app = join(staging, "payload"); mkdirSync(app);
    for (const name of ["package.json", "bun.lock", "tsconfig.json", "LICENSE.md"]) copyFileSync(join(ROOT, name), join(app, name));
    // Desktop addons must never enter this APK. Real Android addons are loaded from nativeLibraryDir.
    await run([process.execPath, "install", "--production", "--omit=optional", "--ignore-scripts", "--frozen-lockfile", "--backend=copyfile",
      ...(offline ? ["--offline"] : [])], app);
    if (!runtimeOnly) {
      const stagedSharp = await Bun.file(join(app, "node_modules/sharp/package.json")).json();
      if (stagedSharp.version !== "0.34.5") throw new Error("Update the Android Sharp build pin to match the installed package.");
      for (const [name, version, library] of [["@img/sharp-android-arm64", stagedSharp.version, "libsharp.so"],
        ["@lancedb/lancedb-android-arm64", pkg.dependencies["@lancedb/lancedb"], "liblancedb.so"]]) {
        const directory = join(app, "node_modules", name); mkdirSync(directory, { recursive: true });
        await Bun.write(join(directory, "package.json"), JSON.stringify({ name, version, main: "index.cjs",
          exports: { ".": "./index.cjs", "./sharp.node": "./index.cjs", "./package.json": "./package.json" } }));
        await Bun.write(join(directory, "index.cjs"), `const { join, isAbsolute } = require('node:path');
const directory = process.env.LUMIVERSE_NATIVE_DIR;
if (process.platform !== 'android' || process.arch !== 'arm64' || !directory || !isAbsolute(directory))
  throw new Error('Launch the Android native addon through the APK host');
process.dlopen(module, join(directory, '${library}'));
`);
      }
      const notices = join(app, "android/native-notices"); mkdirSync(notices, { recursive: true });
      copyFileSync(join(nativeDir, "git-ca-bundle.pem"), join(app, "android/git-ca-bundle.pem"));
      for (const name of ["Sharp.LICENSE", "LanceDB.LICENSE", "sharp.json", "lancedb.json", "lancedb.Cargo.lock", "ffmpeg.json", "git.json", "bun-install-compat.json"])
        copyFileSync(join(nativeDir, name), join(notices, name));
      for (const notice of walkNativeNotices(join(nativeDir, "notices"))) {
        const destination = join(notices, notice.name); mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(notice.path, destination);
      }
      copyFileSync(join(nativeDir, "notices/termux-packages.json"), join(notices, "termux-packages.json"));
      copyFileSync(join(nativeDir, "notices/ffmpeg-packages.json"), join(notices, "ffmpeg-packages.json"));
      copyFileSync(join(nativeDir, "notices/git-packages.json"), join(notices, "git-packages.json"));
      copyFileSync(join(nativeDir, "notices/FFmpeg.NOTICE"), join(notices, "FFmpeg.NOTICE"));
    }
    cpSync(join(ROOT, "src"), join(app, "src"), { recursive: true,
      filter: path => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !["test-fixtures", "__tests__"].includes(path.split(sep).at(-1)!) });
    mkdirSync(join(app, "android"), { recursive: true });
    for (const name of ["runtime.ts", "setup.ts", "index.html", "diagnostics.html", "fonts.conf", "lance-writer.ts", "lance-concurrency.ts", "ffmpeg-check.ts", "git-check.ts"])
      copyFileSync(join(ROOT, "android", name), join(app, "android", name));
    cpSync(join(ROOT, "frontend/dist"), join(app, "frontend/dist"), { recursive: true });
    copyFileSync(join(ROOT, "frontend/package.json"), join(app, "frontend/package.json"));
    cpSync(join(ROOT, "user-docs/docs"), join(app, "user-docs/docs"), { recursive: true });
    const { files } = collectBundleFiles(app);
    // ssh2 ships this Windows Pageant helper even when optional dependencies are omitted.
    delete files["node_modules/ssh2/util/pagent.exe"];
    const native = Object.keys(files).filter(name => /\.(node|so(?:\.\d+)*|dylib|dll|exe)$/.test(name));
    if (native.length) throw new Error(`Unexpected native files in JS payload: ${native.join(", ")}`);
    const payload = zipSync(files, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
    const manifest = { format: 1, version: pkg.version, bunVersion: ANDROID_BUN.version, abi: "arm64-v8a",
      payloadSha256: createHash("sha256").update(payload).digest("hex"), nativeDependencies };
    if (prepareOnly) {
      const directory = join(ROOT, "dist/android/runtime");
      const assets = join(directory, "assets"), libraries = join(directory, "jniLibs/arm64-v8a");
      rmSync(directory, { recursive: true, force: true }); mkdirSync(assets, { recursive: true }); mkdirSync(libraries, { recursive: true });
      writeFileSync(join(assets, "payload.zip"), payload);
      writeFileSync(join(assets, "prototype.json"), JSON.stringify(manifest));
      writeFileSync(join(libraries, "libbun.so"), binary);
      for (const [name, bytes] of Object.entries(nativeFiles)) writeFileSync(join(libraries, name), bytes);
      console.log(`[android] Prepared runtime assets and ${Object.keys(nativeFiles).length + 1} native libraries at ${directory}`);
      return;
    }
    const resources = join(staging, "resources.zip");
    const base = join(staging, "base.apk");
    await run([join(tools, "aapt2"), "compile", "--dir", join(ROOT, "android/res"), "-o", resources]);
    await run([join(tools, "aapt2"), "link", "-o", base, "-I", androidJar, "--manifest", join(ROOT, "android/AndroidManifest.xml"),
      "--min-sdk-version", "29", "--target-sdk-version", "36", "--version-code", "1", "--version-name", `${pkg.version}-prototype.1`, resources]);
    const classes = join(staging, "classes"); mkdirSync(classes);
    await run([join(javaHome, "bin/javac"), "--release", "8", "-classpath", androidJar, "-d", classes,
      join(ROOT, "android/src/chat/lumiverse/prototype/MainActivity.java"), join(ROOT, "android/src/chat/lumiverse/prototype/RuntimeHost.java")]);
    const jar = join(staging, "classes.jar");
    await run([join(javaHome, "bin/jar"), "cf", jar, "-C", classes, "."]);
    const dex = join(staging, "dex"); mkdirSync(dex);
    await run([join(tools, "d8"), "--lib", androidJar, "--min-api", "29", "--output", dex, jar]);
    const entries = unzipSync(readFileSync(base));
    entries["classes.dex"] = readFileSync(join(dex, "classes.dex"));
    entries["assets/payload.zip"] = payload;
    entries["assets/prototype.json"] = Buffer.from(JSON.stringify(manifest));
    // Android installs lib*.so files into nativeLibraryDir with execution permission.
    // Bun stays there; executable code is never copied into writable app data.
    entries["lib/arm64-v8a/libbun.so"] = binary;
    for (const [name, bytes] of Object.entries(nativeFiles)) entries[`lib/arm64-v8a/${name}`] = bytes;
    const unsigned = join(staging, "unsigned.apk");
    const apkEntries: Zippable = { ...entries,
      // Android 11+ rejects APKs with a compressed resource table.
      "resources.arsc": [entries["resources.arsc"]!, { level: 0 }],
    };
    await Bun.write(unsigned, zipSync(apkEntries, { level: 6 }));
    const aligned = join(staging, "aligned.apk");
    await run([join(tools, "zipalign"), "-f", "-P", "16", "4", unsigned, aligned]);
    const keystore = join(ROOT, ".tmp/android-prototype/debug.keystore");
    if (!existsSync(keystore)) await run([join(javaHome, "bin/keytool"), "-genkeypair", "-keystore", keystore,
      "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
      "-validity", "10000", "-dname", "CN=Lumiverse Android Prototype,O=Lumiverse,C=US"]);
    const directory = join(ROOT, "dist/android"); mkdirSync(directory, { recursive: true });
    const apk = join(directory, "lumiverse-prototype-arm64.apk");
    await run([join(tools, "apksigner"), "sign", "--ks", keystore, "--ks-key-alias", "androiddebugkey",
      "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", apk, aligned]);
    await run([join(tools, "apksigner"), "verify", "--verbose", apk]);
    await run([join(tools, "zipalign"), "-c", "-P", "16", "4", apk]);
    await Bun.write(apk + ".json", JSON.stringify(manifest, null, 2) + "\n");
    await Bun.write(apk + ".sha256", `${createHash("sha256").update(readFileSync(apk)).digest("hex")}  lumiverse-prototype-arm64.apk\n`);
    console.log(`[android] Built ${apk} (${(Bun.file(apk).size / 1024 ** 2).toFixed(1)} MiB)`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (import.meta.main) await build();
