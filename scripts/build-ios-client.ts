#!/usr/bin/env bun
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { configureIOSPushEntitlements } from "./ios-entitlements";

const root = resolve(import.meta.dir, ".."), project = join(root, "ios/tauri");
const generated = join(project, "src-tauri/gen/apple");
const args = new Set(process.argv.slice(2));
const simulator = args.has("--simulator"), unsigned = args.has("--unsigned") || simulator;
const experimentalHighRefresh = args.has("--experimental-high-refresh");
const pushNotifications = args.has("--push-notifications");
const artifactSuffix = (experimentalHighRefresh ? "-experimental-high-refresh" : "") + (pushNotifications ? "-push" : "");
if (process.platform !== "darwin") throw new Error("iOS builds require macOS and Xcode.");
const cli = join(root, "desktop/node_modules/@tauri-apps/cli/tauri.js");
if (!existsSync(cli)) throw new Error("Install the locked desktop CLI first: bun install --cwd desktop --frozen-lockfile");
const pbxPath = join(generated, "lumiverse-ios-client.xcodeproj/project.pbxproj");
const configuredTeams = existsSync(pbxPath) ? [...new Set([...readFileSync(pbxPath, "utf8")
  .matchAll(/DEVELOPMENT_TEAM\s*=\s*"?([A-Z0-9]{10})"?\s*;/g)].map(match => match[1]))] : [];
const team = process.env.APPLE_DEVELOPMENT_TEAM || (configuredTeams.length === 1 ? configuredTeams[0] : undefined);
if (team && !/^[A-Z0-9]{10}$/.test(team)) throw new Error("APPLE_DEVELOPMENT_TEAM must be a 10-character Apple Team ID.");
if (!unsigned && !args.has("--prepare-only") && !team)
  throw new Error("Select a signing team in the generated Xcode project or set APPLE_DEVELOPMENT_TEAM. Use --unsigned or --simulator to build without signing.");
const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer",
  CARGO_TARGET_DIR: join(root, ".tmp/ios-rust"), IPHONEOS_DEPLOYMENT_TARGET: "15.0",
  LUMIVERSE_IOS_EXPERIMENTAL_HIGH_REFRESH: experimentalHighRefresh ? "1" : "0",
  ...(team ? { APPLE_DEVELOPMENT_TEAM: team } : {}),
  ...(args.has("--offline") ? { CARGO_NET_OFFLINE: "true" } : {}) };
async function run(command: string[], cwd = project, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...env, ...extraEnv }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`iOS client build failed: ${command.join(" ")}`);
}
await run(["xcodebuild", "-version"]);
if (!existsSync(join(generated, "project.yml")))
  await run(["node", cli, "ios", "init", "--ci", "--skip-targets-install"]);
copyFileSync(join(root, "frontend/public/icon.svg"), join(project, "ui/icon.svg"));
const icons = join(root, ".tmp/ios-icons");
await run(["node", cli, "icon", join(root, "frontend/public/icon.svg"), "--output", icons, "--ios-color", "#231e30"]);
cpSync(join(icons, "ios"), join(generated, "Assets.xcassets/AppIcon.appiconset"), { recursive: true });
const specPath = join(generated, "project.yml");
let spec = readFileSync(specPath, "utf8");
// Xcode GUI builds have a minimal PATH and no Tauri CLI options server. Use
// the same standalone Rust build phase as this packaging helper.
spec = spec.replace(/    preBuildScripts:\n(?:[ \t]{6,}[^\n]*(?:\n|$)|[ \t]*\n)*/, `    preBuildScripts:
      - script: /bin/sh "$SRCROOT/../../../../../scripts/build-ios-xcode.sh"
        name: Build Rust Code
        basedOnDependencyAnalysis: false
        outputFiles:
          - $(SRCROOT)/Externals/$(PLATFORM_NAME)/arm64/$(CONFIGURATION)/libapp.a
`);
spec = spec.replace(/(LIBRARY_SEARCH_PATHS\[arch=(?:arm64|x86_64)\]:[^\n]*?Externals\/)(?:\$\(PLATFORM_NAME\)\/)?/g,
  "$1$(PLATFORM_NAME)/");
if (!spec.includes("ENABLE_USER_SCRIPT_SANDBOXING:"))
  spec = spec.replace("        ENABLE_BITCODE:", "        ENABLE_USER_SCRIPT_SANDBOXING: false\n        ENABLE_BITCODE:");
// Persist the explicit opt-in for Xcode's Run action; ordinary invocations reset it.
spec = spec.replace(/        LUMIVERSE_IOS_EXPERIMENTAL_HIGH_REFRESH:.*\n/g, "");
spec = spec.replace("        ENABLE_BITCODE:",
  `        LUMIVERSE_IOS_EXPERIMENTAL_HIGH_REFRESH: "${experimentalHighRefresh ? "1" : "0"}"\n        ENABLE_BITCODE:`);
// The static library is a linker input, never a copied application resource.
spec = spec.replace(/      - path: Externals(?:\n        buildPhase: \w+)?/,
  "      - path: Externals\n        buildPhase: none");
// Preserve the team selected in Xcode when regenerating the project.
if (team) {
  spec = spec.replace(/      # Lumiverse signing\n[\s\S]*?      # End Lumiverse signing\n/, "");
  spec = spec.replace("      PRODUCT_NAME:", `      # Lumiverse signing\n      DEVELOPMENT_TEAM: "${team}"\n      CODE_SIGN_STYLE: Automatic\n      # End Lumiverse signing\n      PRODUCT_NAME:`);
}
// Direct Xcode builds need the same custom Info.plist values as CLI builds.
const plist = Bun.spawn(["plutil", "-convert", "json", "-o", "-", join(project, "src-tauri/Info.ios.plist")],
  { env, stdout: "pipe", stderr: "inherit" });
const properties = JSON.parse(await new Response(plist.stdout).text()) as Record<string, unknown>;
if (await plist.exited !== 0) throw new Error("Could not read the iOS Info.plist.");
properties.LumiversePushEnabled = pushNotifications;
spec = spec.replace(/        # Lumiverse Info.plist\n[\s\S]*?        # End Lumiverse Info.plist\n/, "");
const extraInfo = Object.entries(properties).map(([key, value]) => `        ${key}: ${JSON.stringify(value)}\n`).join("");
spec = spec.replace("        LSRequiresIPhoneOS:", `        # Lumiverse Info.plist\n${extraInfo}        # End Lumiverse Info.plist\n        LSRequiresIPhoneOS:`);
// Keep ordinary Personal Team builds usable. Push is explicit because Xcode must
// provision this App ID with Apple's APNs capability before it can sign the IPA.
// XcodeGen rewrites this file from its `properties`; editing the generated plist
// alone would silently remove the entitlement when the project is regenerated.
spec = configureIOSPushEntitlements(spec, pushNotifications);
writeFileSync(specPath, spec);
await run(["xcodegen", "generate", "--spec", "project.yml"], generated);
if (args.has("--prepare-only")) process.exit(0);
const configuration = args.has("--debug") ? "debug" : "release";
const derived = join(root, ".tmp/ios-xcode", (simulator ? "simulator" : "device") + artifactSuffix);
{
  // Compile once, then let Xcode package the same Rust/Swift application for
  // simulator, unsigned device, or provisioned development distribution.
  await run(["/bin/sh", join(root, "scripts/build-ios-xcode.sh")], project, {
    SRCROOT: generated, PLATFORM_NAME: simulator ? "iphonesimulator" : "iphoneos",
    CONFIGURATION: configuration, ARCHS: "arm64", LUMIVERSE_IOS_PREBUILT_RUST: "0",
  });
  const xcode = ["xcodebuild", "-quiet", "-project", "lumiverse-ios-client.xcodeproj", "-scheme", "lumiverse-ios-client_iOS",
    "-configuration", configuration, "-sdk", simulator ? "iphonesimulator" : "iphoneos",
    "-destination", simulator ? "generic/platform=iOS Simulator" : "generic/platform=iOS", "-derivedDataPath", derived,
    "LUMIVERSE_IOS_PREBUILT_RUST=1", `LUMIVERSE_IOS_EXPERIMENTAL_HIGH_REFRESH=${experimentalHighRefresh ? "1" : "0"}`];
  if (unsigned) xcode.push("CODE_SIGNING_ALLOWED=NO");
  else xcode.push(`DEVELOPMENT_TEAM=${team}`, "CODE_SIGN_STYLE=Automatic", "CODE_SIGN_IDENTITY=Apple Development",
    "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration");
  if (simulator) xcode.push("build");
  else xcode.push("-archivePath", join(generated, "build/arm64", unsigned ? "Lumiverse-unsigned.xcarchive" : "Lumiverse.xcarchive"), "archive");
  await run(xcode, generated);
  if (!unsigned) {
    const exportOptions = join(generated, "LumiverseExportOptions.plist");
    writeFileSync(exportOptions, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>method</key><string>debugging</string><key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>${team}</string><key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>\n`);
    await run(["xcodebuild", "-quiet", "-exportArchive", "-archivePath", join(generated, "build/arm64/Lumiverse.xcarchive"),
      "-exportOptionsPlist", exportOptions, "-exportPath", join(generated, "build/arm64/export"), "-allowProvisioningUpdates"], generated);
  }
}

function find(path: string, suffix: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const candidate = join(path, entry.name);
    return entry.name.endsWith(suffix) ? [candidate] : entry.isDirectory() ? find(candidate, suffix) : [];
  });
}
const out = join(root, "dist/ios"); mkdirSync(out, { recursive: true });
let artifact: string;
if (simulator) {
  const app = find(join(derived, "Build/Products"), ".app").find(path => path.includes("iphonesimulator"));
  if (!app) throw new Error("Xcode did not produce an iOS simulator application.");
  artifact = join(out, `Lumiverse-simulator${artifactSuffix}.app`);
  rmSync(artifact, { recursive: true, force: true });
  cpSync(app, artifact, { recursive: true });
} else if (unsigned) {
  const archive = join(generated, "build/arm64/Lumiverse-unsigned.xcarchive");
  const app = find(join(archive, "Products/Applications"), ".app")[0];
  if (!app) throw new Error("Xcode did not produce an application archive.");
  const entries: Zippable = {};
  function pack(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const candidate = join(path, entry.name);
      if (entry.isDirectory()) pack(candidate);
      else entries[`Payload/Lumiverse.app/${relative(app!, candidate)}`] = [readFileSync(candidate),
        { os: 3, attrs: (entry.name === "Lumiverse" ? 0o100755 : 0o100644) << 16 }];
    }
  }
  pack(app);
  artifact = join(out, `lumiverse-ios-arm64-unsigned${artifactSuffix}.ipa`);
  writeFileSync(artifact, zipSync(entries, { level: 6 }));
} else {
  const app = join(generated, "build/arm64/Lumiverse.xcarchive/Products/Applications/Lumiverse.app");
  const signature = Bun.spawn(["codesign", "-d", "--entitlements", ":-", app], { env, stdout: "pipe", stderr: "pipe" });
  const signedEntitlements = await new Response(signature.stdout).text();
  await new Response(signature.stderr).text();
  if (await signature.exited !== 0) throw new Error("Could not verify the archived application's signing entitlements.");
  const signedForPush = /<key>aps-environment<\/key>\s*<string>(development|production)<\/string>/.test(signedEntitlements);
  if (signedForPush !== pushNotifications) throw new Error("The signed app's APNs entitlement does not match this build's push configuration.");
  const ipa = find(join(generated, "build/arm64/export"), ".ipa")[0];
  if (!ipa) throw new Error("Xcode did not export a signed IPA.");
  artifact = join(out, `lumiverse-ios-arm64${artifactSuffix}.ipa`); copyFileSync(ipa, artifact);
}
const metadata = { artifact: relative(root, artifact), target: simulator ? "aarch64-apple-ios-sim" : "aarch64-apple-ios",
  signed: !unsigned, debug: args.has("--debug"), backend: "remote", version: "0.3.1",
  experimentalHighRefresh,
  pushNotifications,
  ...(simulator ? {} : { sha256: new Bun.CryptoHasher("sha256").update(readFileSync(artifact)).digest("hex") }) };
writeFileSync(join(out, `${simulator ? "simulator-build" : "ipa-build"}${artifactSuffix}.json`), JSON.stringify(metadata, null, 2) + "\n");
console.log(`[ios] Built ${artifact}${unsigned && !simulator ? " (unsigned; requires provisioning and signing before installation)" : ""}`);
