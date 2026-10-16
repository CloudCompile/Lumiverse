#!/usr/bin/env bun
/** Reproduce OEM seccomp traps independently of the emulator kernel's allowlist. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { androidNdkLlvm } from "./android-native";
import { buildAndroidBunCompat } from "./build-bun-android-compat";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const serial = args[args.indexOf("--serial") + 1];
assert.ok(args.includes("--serial") && serial?.startsWith("emulator-"), "Select a disposable emulator with --serial");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.HOME || "", "Library/Android/sdk");
const adb = join(sdk, "platform-tools/adb");
async function run(cmd: string[], allowFailure = false) {
  const process = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (!allowFailure) assert.equal(code, 0, `${cmd.join(" ")}: ${stderr || stdout}`);
  return { code, stdout, stderr };
}
const device = (...command: string[]) => [adb, "-s", serial!, ...command];
const staging = mkdtempSync(join(root, ".tmp/android-install-"));
const remote = `/data/local/tmp/lumiverse-install-${Date.now()}`;
try {
  const llvm = androidNdkLlvm(process.env.ANDROID_NDK_HOME || join(root, ".tmp/android-native/android-ndk-r28c"));
  const compat = await buildAndroidBunCompat(staging);
  await run([join(llvm, "aarch64-linux-android29-clang"), "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "-Wl,-z,max-page-size=16384", join(root, "android/native/tests/install-seccomp.c"), "-o", join(staging, "install-seccomp")]);
  const installed = (await run(device("shell", "pm", "path", "chat.lumiverse.prototype"))).stdout.trim().replace(/^package:/, "");
  assert.ok(installed.endsWith("/base.apk"));
  const bun = installed.replace(/base\.apk$/, "lib/arm64/libbun.so");
  const installedCompat = installed.replace(/base\.apk$/, `lib/arm64/${compat.library}`);
  const deviceHash = (await run(device("shell", "sha256sum", installedCompat))).stdout.split(/\s+/)[0];
  assert.equal(deviceHash, compat.sha256, "Exercise the compatibility library actually shipped in the installed APK");
  const packageDir = join(staging, "package"); mkdirSync(packageDir);
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "android-bin-fixture", version: "1.0.0",
    bin: { "fixture-tool": "cli.js", "escape-tool": "escaping.js" } }));
  writeFileSync(join(packageDir, "cli.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n", { mode: 0o644 });
  symlinkSync("../outside.js", join(packageDir, "escaping.js"));
  await run(["tar", "-czf", join(staging, "fixture.tgz"), "-C", staging, "package"]);
  rmSync(packageDir, { recursive: true }); // Push the archive, not its host symlink.
  writeFileSync(join(staging, "package.json"), JSON.stringify({ dependencies: { "android-bin-fixture": "file:./fixture.tgz" } }));
  await run(device("push", staging, remote));
  await run(device("shell", "chmod", "755", `${remote}/install-seccomp`));
  const prefix = ["shell", "env", `HOME=${remote}`, `TMPDIR=${remote}`, `BUN_INSTALL_CACHE_DIR=${remote}/cache`];
  const preload = `LD_PRELOAD=${installedCompat}`;
  // cd is needed for Bun's project discovery; every interpolated path is generated here.
  const install = `cd ${remote} && ./install-seccomp exec ${bun} install --ignore-scripts --backend=copyfile`;
  const baseline = await run(device(...prefix, "sh", "-c", `'${install}'`), true);
  assert.equal(baseline.code, 159, `The unmodified runtime must reproduce SIGSYS: ${JSON.stringify(baseline)}`);
  await run(device("shell", "rm", "-rf", `${remote}/node_modules`));
  await run(device("shell", "mkdir", `${remote}/node_modules`));
  writeFileSync(join(staging, "outside.js"), "// Must remain outside the package and non-executable.\n", { mode: 0o644 });
  await run(device("push", join(staging, "outside.js"), `${remote}/node_modules/outside.js`));
  const recovered = await run(device(...prefix, preload, "sh", "-c", `'${install}'`));
  await run(device("shell", "test", "-x", `${remote}/node_modules/.bin/fixture-tool`));
  await run(device("shell", "test", "!", "-L", `${remote}/node_modules/.bin/escape-tool`));
  await run(device("shell", "test", "!", "-x", `${remote}/node_modules/outside.js`));
  const probe = await run(device(...prefix, preload, `${remote}/install-seccomp`, "probe"));
  for (const mode of ["user-signal", "unknown-syscall"]) {
    const result = await run(device(...prefix, preload, `${remote}/install-seccomp`, mode), true);
    assert.equal(result.code, 159, `Compatibility must preserve fatal SIGSYS for ${mode}`);
  }
  const report = { testedAt: new Date().toISOString(), serial, bun: "1.4.2", trappedSyscalls: ["openat2", "fchmodat2"],
    baselineExitCode: baseline.code, compatibilityExitCode: recovered.code, binExecutable: true, escapingBinRejected: true,
    signalForwarding: probe.stdout.trim(), otherSigsysRemainFatal: true, compatibilitySource: "installed-apk", compatibilitySha256: compat.sha256 };
  const reportIndex = args.indexOf("--report");
  if (reportIndex >= 0) await Bun.write(resolve(args[reportIndex + 1]!), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await run(device("shell", "rm", "-rf", remote));
  rmSync(staging, { recursive: true, force: true });
}
