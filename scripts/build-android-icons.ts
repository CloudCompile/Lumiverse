#!/usr/bin/env bun
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Keep Android artwork derived from the existing Lumiverse PWA icon. */
export async function buildAndroidIcons(root: string, cli: string, env = process.env) {
  const source = join(root, "frontend/public/icon.svg");
  const svg = readFileSync(source, "utf8");
  const backgroundRect = svg.match(/<rect\b[^>]*\/>/g);
  if (backgroundRect?.length !== 1) throw new Error("Lumiverse icon must have one background rectangle for adaptive layers");
  const foreground = svg.replace(backgroundRect[0]!, "");
  const background = svg.replace(/<path\b[^>]*\/>/g, "").replace(/\s+rx="[^"]*"/, "");
  const monochrome = foreground.replace(/<defs>[\s\S]*?<\/defs>/, "")
    .replace(/fill="[^"]*"/g, 'fill="#FFFFFF"').replace(/opacity="[^"]*"/g, 'opacity="1"');
  const staging = join(root, ".tmp/android-icons"); mkdirSync(staging, { recursive: true });
  for (const [name, content] of [["foreground.svg", foreground], ["background.svg", background], ["monochrome.svg", monochrome]])
    writeFileSync(join(staging, name!), content!);
  const manifest = join(staging, "icon.json");
  writeFileSync(manifest, JSON.stringify({ default: source, android_fg: "foreground.svg", android_bg: "background.svg",
    android_fg_scale: 85, android_monochrome: "monochrome.svg", bg_color: "#231E30" }));
  const output = join(staging, "output");
  const child = Bun.spawn([cli, "icon", manifest, "--output", output], {
    cwd: join(root, "android/tauri"), env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  if (await child.exited !== 0) throw new Error("Android launcher icon generation failed");
  const resources = join(root, "android/tauri/src-tauri/gen/android/app/src/main/res");
  cpSync(join(output, "android"), resources, { recursive: true });
  copyFileSync(join(resources, "mipmap-anydpi-v26/ic_launcher.xml"), join(resources, "mipmap-anydpi-v26/ic_launcher_round.xml"));
  console.log("[android] Launcher icons generated from frontend/public/icon.svg");
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  await buildAndroidIcons(root, join(root, "desktop/node_modules/.bin/tauri"));
}
