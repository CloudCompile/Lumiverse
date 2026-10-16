#!/usr/bin/env bun
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { androidSystemLibraries, nativeSha256, readAndroidElf } from "./android-native";
import { buildAndroidIcons } from "./build-android-icons";

const root = resolve(import.meta.dir, ".."), project = join(root, "android/tauri");
const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? resolve(args[index + 1]!) : undefined;
}
const sdk = option("--sdk") || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.HOME || "", "Library/Android/sdk");
const ndk = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME || join(root, ".tmp/android-native/android-ndk-r28c");
const java = option("--java-home") || process.env.JAVA_HOME || "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
const env = { ...process.env, ANDROID_HOME: sdk, NDK_HOME: ndk, JAVA_HOME: java,
  GRADLE_USER_HOME: join(root, ".tmp/gradle"), PATH: join(java, "bin") + ":" + process.env.PATH,
  ...(args.includes("--offline") ? { CARGO_NET_OFFLINE: "true", LUMIVERSE_ANDROID_OFFLINE: "1" } : {}) };
async function run(cmd: string[], cwd = root) {
  const child = Bun.spawn(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Tauri Android build failed: ${cmd[0]}`);
}
const cli = join(root, "desktop/node_modules/.bin/tauri");
if (!existsSync(cli)) throw new Error("Install the desktop package's locked Tauri CLI first: bun install --frozen-lockfile in desktop/");
await run([process.execPath, "run", "build:android-prototype", "--prepare-only", ...args]);
const generated = join(project, "src-tauri/gen/android"), main = join(generated, "app/src/main");
cpSync(join(root, "dist/android/runtime/assets"), join(main, "assets"), { recursive: true });
// The CLI recreates its Tauri library. Remove previous payload libraries so
// runtime-only builds and changed dependency sets cannot retain stale native code.
rmSync(join(main, "jniLibs"), { recursive: true, force: true });
cpSync(join(root, "dist/android/runtime/jniLibs"), join(main, "jniLibs"), { recursive: true });
copyFileSync(join(root, "android/res/xml/network_security_config.xml"), join(main, "res/xml/network_security_config.xml"));
await buildAndroidIcons(root, cli, env);
await run([cli, "android", "build", "--debug", "--apk", "--target", "aarch64", "--ci"], project);
const outputs = join(generated, "app/build/outputs/apk/universal/debug");
const built = readdirSync(outputs).find(name => name.endsWith(".apk"));
if (!built) throw new Error("Tauri did not produce the ARM64 APK");
const entries = unzipSync(readFileSync(join(outputs, built)));
if (Object.keys(entries).some(name => name.startsWith("lib/") && !name.startsWith("lib/arm64-v8a/")))
  throw new Error("Prototype APK must contain only the selected ARM64 ABI");
const libraries = Object.entries(entries).filter(([name]) => name.startsWith("lib/arm64-v8a/"));
const available = new Set(libraries.map(([name]) => name.split("/").at(-1)!));
for (const [name, bytes] of libraries) {
  if (name.endsWith("libbun.so")) continue; // Pinned official runtime is verified by the payload builder.
  const elf = readAndroidElf(bytes, { executable: /\/(?:libff(?:mpeg|probe)|libgit(?:remotehttp)?)\.so$/.test(name) });
  if (elf.loads.some(segment => segment.alignment < 16384 || (segment.offset - segment.address) % 16384 !== 0))
    throw new Error(`Tauri APK library lacks 16 KiB alignment: ${name}`);
  for (const dependency of elf.needed)
    if (!androidSystemLibraries.has(dependency) && !available.has(dependency)) throw new Error(`${name} requires missing ${dependency}`);
}
const tools = join(sdk, "build-tools", readdirSync(join(sdk, "build-tools")).filter(name => /^\d+\.\d+\.\d+$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)!);
const out = join(root, "dist/android"); mkdirSync(out, { recursive: true });
const apk = join(out, "lumiverse-tauri-arm64.apk"), keystore = join(root, ".tmp/android-prototype/debug.keystore");
if (!existsSync(keystore)) await run([join(java, "bin/keytool"), "-genkeypair", "-keystore", keystore,
  "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048",
  "-validity", "10000", "-dname", "CN=Lumiverse Android Prototype,O=Lumiverse,C=US"]);
// Incremental Gradle ZIPs retain holes from replaced payloads. Compact them,
// remove old signatures, and align before signing with the shared prototype key.
for (const name of Object.keys(entries))
  if (/^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$/i.test(name)) delete entries[name];
const staging = mkdtempSync(join(root, ".tmp/android-prototype/tauri-apk-"));
try {
  const unsigned = join(staging, "unsigned.apk"), aligned = join(staging, "aligned.apk");
  const compact: Zippable = { ...entries, "resources.arsc": [entries["resources.arsc"]!, { level: 0 }] };
  writeFileSync(unsigned, zipSync(compact, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") }));
  await run([join(tools, "zipalign"), "-f", "-P", "16", "4", unsigned, aligned]);
  await run([join(tools, "apksigner"), "sign", "--ks", keystore, "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android",
    "--key-pass", "pass:android", "--out", apk, aligned]);
} finally { rmSync(staging, { recursive: true, force: true }); }
await run([join(tools, "apksigner"), "verify", "--verbose", apk]);
await run([join(tools, "zipalign"), "-c", "-P", "16", "4", apk]);
const manifest = { ...JSON.parse(Buffer.from(entries["assets/prototype.json"]!).toString()), host: "tauri", tauriVersion: "2.11.5" };
writeFileSync(apk + ".json", JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(apk + ".sha256", `${nativeSha256(readFileSync(apk))}  lumiverse-tauri-arm64.apk\n`);
console.log(`[android] Built Tauri APK: ${apk} (${(Bun.file(apk).size / 1024 ** 2).toFixed(1)} MiB)`);
