#!/usr/bin/env bun
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const targets: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu", "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error("No bundled desktop server is available for this platform.");
const args = process.argv.slice(2);
const reuse = args.includes("--reuse-server");
const stageOnly = args.includes("--stage-only");
const tauriArgs = args.filter((arg) => !["--reuse-server", "--stage-only"].includes(arg));
async function run(cmd: string[], cwd = root) {
  const child = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Build failed: ${cmd.join(" ")}`);
}
if (!reuse) await run([process.execPath, "run", "build:server"]);
const extension = process.platform === "win32" ? ".exe" : "";
const server = join(root, "dist/server", `lumiverse-server-${process.platform}-${process.arch}${extension}`);
const metadata = await Bun.file(server + ".json").json();
if (metadata.platform !== process.platform || metadata.arch !== process.arch || metadata.bunVersion !== Bun.version) throw new Error("The staged server must match the desktop's native architecture and pinned Bun version.");
const directory = join(root, "desktop/src-tauri/binaries");
mkdirSync(directory, { recursive: true });
copyFileSync(server, join(directory, `lumiverse-server-${target}${extension}`));
console.log(`[desktop-bundle] Staged the ${target} server.`);
if (!stageOnly) await run([process.execPath, "run", "tauri:finalized", "build", "--config", "src-tauri/tauri.server-bundle.conf.json",
  ...(tauriArgs.includes("--debug") || tauriArgs.includes("-d") ? ["--config", "src-tauri/tauri.debug-profile.conf.json"] : []),
  ...tauriArgs], join(root, "desktop"));
