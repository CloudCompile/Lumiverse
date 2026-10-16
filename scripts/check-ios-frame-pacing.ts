#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const index = process.argv.indexOf("--device");
const device = process.argv[index + 1];
if (index < 0 || !device || device.startsWith("--")) throw new Error("Specify the connected iPhone UDID with --device.");
const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer" };
const out = join(root, "dist/ios");
mkdirSync(out, { recursive: true });
async function deviceCommand(args: string[], allowFailure = false) {
  const [category, operation, ...options] = args;
  // Launch arguments consume the rest of the command line; device options must
  // precede the application identifier and its diagnostic arguments.
  const child = Bun.spawn(["xcrun", "devicectl", "device", category, operation, "--device", device, "--timeout", "10", ...options],
    { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0 && !allowFailure) throw new Error(stderr || stdout);
  return code === 0;
}
type Sample = {
  runID: string; passed: boolean; error?: string;
  override: { status: string; preferenceAfter?: boolean };
  javascript?: { fps: number; frameCount: number; p50IntervalMs: number; p95IntervalMs: number };
  nativeDisplayLink?: { callbackHz: number };
  maximumDisplayHz: number; lowPowerMode: boolean; thermalState: number; osVersion: string;
};
const samples: Record<string, Sample> = {};
try {
  for (const [name, extra] of [
    ["baseline", ["--lumiverse-disable-high-refresh"]],
    ["override", []],
    ["override-native-demand", ["--lumiverse-frame-pacing-native-demand"]],
  ] as const) {
    const runID = crypto.randomUUID();
    console.log(`[ios] Measuring ${name}; keep the iPhone unlocked and Lumiverse visible.`);
    await deviceCommand(["process", "launch", "--terminate-existing", "chat.lumiverse.ios",
      "--lumiverse-frame-pacing-probe", `--lumiverse-frame-pacing-id=${runID}`, ...extra]);
    const reportPath = join(out, `frame-pacing-${name}.json`);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await Bun.sleep(1000);
      if (!await deviceCommand(["copy", "from", "--domain-type", "appDataContainer",
        "--domain-identifier", "chat.lumiverse.ios", "--source", "Library/Caches/lumiverse-frame-pacing.json",
        "--destination", reportPath], true)) continue;
      const sample = JSON.parse(readFileSync(reportPath, "utf8")) as Sample;
      if (sample.runID !== runID) continue;
      if (!sample.passed || !sample.javascript) throw new Error(sample.error || "No JavaScript timing samples.");
      if (sample.override.status !== (name === "baseline" ? "disabled-for-comparison" : "override-applied"))
        throw new Error(`The installed app did not apply the expected mode: ${sample.override.status}. Install a debug experimental build first.`);
      if (name === "override-native-demand" && !(sample.nativeDisplayLink && sample.nativeDisplayLink.callbackHz > 0))
        throw new Error("The native display-link comparison returned no callbacks.");
      samples[name] = sample;
      console.log(`[ios] ${name}: JavaScript ${sample.javascript.fps.toFixed(1)} fps` +
        (sample.nativeDisplayLink ? `; native callbacks ${sample.nativeDisplayLink.callbackHz.toFixed(1)} Hz` : ""));
      break;
    }
    if (!samples[name]) throw new Error(`Timed out waiting for ${name}. Install a debug experimental build and keep the iPhone unlocked.`);
  }
  const summary = Object.fromEntries(Object.entries(samples).map(([name, sample]) => [name, {
    ...sample, javascript: { fps: sample.javascript!.fps, frameCount: sample.javascript!.frameCount,
      p50IntervalMs: sample.javascript!.p50IntervalMs, p95IntervalMs: sample.javascript!.p95IntervalMs },
  }]));
  writeFileSync(join(out, "frame-pacing-comparison.json"), JSON.stringify({ device, samples: summary,
    note: "JavaScript callbacks and native CADisplayLink callbacks are separate measurements; neither directly measures presented compositor frames." }, null, 2) + "\n");
} finally {
  // Return to the saved server without changing its settings or website data.
  await deviceCommand(["process", "launch", "--terminate-existing", "chat.lumiverse.ios"]);
}
