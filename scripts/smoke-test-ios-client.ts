#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const generated = join(root, "ios/tauri/src-tauri/gen/apple");
const serialIndex = process.argv.indexOf("--simulator");
const simulator = process.argv[serialIndex + 1];
if (serialIndex < 0 || !simulator || simulator.startsWith("--")) throw new Error("Specify an iOS simulator UUID with --simulator.");
if (!existsSync(join(root, "dist/ios/Lumiverse-simulator.app"))) throw new Error("Build first: bun run build:ios-client --simulator --debug");
const env = { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer" };
async function run(command: string[], cwd = generated) {
  const child = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`iOS smoke test failed: ${command.join(" ")}`);
}
// Never reset an app on a simulator that might contain the user's data.
const devices = Bun.spawn(["xcrun", "simctl", "list", "devices", "--json"], { env, stdout: "pipe", stderr: "inherit" });
const deviceList = JSON.parse(await new Response(devices.stdout).text()) as { devices: Record<string, { udid: string; name: string }[]> };
if (await devices.exited !== 0 || !Object.values(deviceList.devices).flat().some(device => device.udid === simulator && device.name.startsWith("LumiverseClientSmoke")))
  throw new Error("Use a dedicated simulator named LumiverseClientSmoke; this test resets its Lumiverse installation.");
let identityVerified = false, commandsBlocked = false, restoredCookie = false, nativePermissionsVerified = false, nativeFramesBlocked = false, speechPermissionHandled = false;
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 18763, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/runtime-config") return Response.json({ safeThemeMode: false });
  if (url.pathname === '/speech-denied' && request.method === 'POST') {
    speechPermissionHandled = true;
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/check" && request.method === "POST") {
    const result = await request.json() as { identityVerified: boolean; commandsBlocked: boolean; nativePermissionsVerified: boolean; nativeFramesBlocked: boolean };
    identityVerified ||= result.identityVerified;
    commandsBlocked ||= result.commandsBlocked;
    nativePermissionsVerified ||= result.nativePermissionsVerified;
    nativeFramesBlocked ||= result.nativeFramesBlocked;
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/native-frame') return new Response(`<!doctype html><script>
    (async () => {
      let blocked = false;
      try { await window.webkit.messageHandlers.lumiverseNative.postMessage({action:'notifications.status'}); }
      catch { blocked = true; }
      parent.postMessage({nativeFrameBlocked: blocked}, location.origin);
    })();</script>`, { headers: { 'Content-Type': 'text/html' } });
  if (request.method === "GET" && request.headers.get("Cookie")?.includes("lumiverse_ios_smoke=1")) restoredCookie = true;
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
    <h1>Remote Lumiverse</h1><p id="identity"></p><p id="commands"></p><p id="permissions"></p>
    <button id="speech">Try native dictation</button><p id="speech-result"></p>
    <script>(async () => {
      await new Promise(resolve => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', resolve, {once:true}) : resolve());
      const identityVerified = window.__LUMIVERSE_MOBILE__ === true && window.__LUMIVERSE_PLATFORM__ === 'ios'
        && document.documentElement.dataset.platform === 'ios' && !document.documentElement.hasAttribute('data-tauri-desktop')
        && Object.getOwnPropertyDescriptor(window, '__LUMIVERSE_MOBILE__').writable === false;
      document.getElementById('speech').onclick = async () => {
        try { await window.__LUMIVERSE_IOS_NATIVE__.request('speech.start', {id:crypto.randomUUID(),language:'en-US'}); }
        catch (error) {
          if (String(error).includes('Speech Recognition')) {
            document.getElementById('speech-result').textContent = 'Speech permission denial handled';
            await fetch('/speech-denied', {method:'POST'});
          }
        }
      };
      let commandsBlocked = true;
      for (const [command, args] of [['mobile_connection_info', {}], ['mobile_connect', {server:'https://example.com/'}], ['plugin:fs|read_text_file', {path:'/etc/passwd'}]]) {
        try { await window.__TAURI_INTERNALS__.invoke(command, args); commandsBlocked = false; } catch {}
      }
      document.getElementById('identity').textContent = identityVerified ? 'iOS mobile identity verified' : 'Identity failed';
      document.getElementById('commands').textContent = commandsBlocked ? 'Native commands blocked' : 'Commands exposed';
      let nativePermissionsVerified = false, nativeFramesBlocked = false;
      try {
        const bridge = window.__LUMIVERSE_IOS_NATIVE__;
        const notifications = await bridge.request('notifications.status');
        const permissions = await bridge.request('permissions.status');
        let unknownBlocked = false;
        try { await bridge.request('fs.read', {path:'/etc/passwd'}); } catch { unknownBlocked = true; }
        nativePermissionsVerified = bridge.version === 1 && Object.isFrozen(bridge)
          && typeof notifications.deviceId === 'string' && notifications.bundleId === 'chat.lumiverse.ios'
          && (notifications.available === true || String(notifications.reason).startsWith('This IPA was built without Push Notifications.'))
          && ['granted','default','denied'].includes(notifications.permission)
          && ['granted','default','denied'].includes(permissions.camera)
          && ['granted','default','denied'].includes(permissions.microphone) && unknownBlocked;
        nativeFramesBlocked = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 5000);
          const listener = event => {
            if (event.origin !== location.origin || event.data?.nativeFrameBlocked === undefined) return;
            clearTimeout(timer); window.removeEventListener('message', listener); resolve(event.data.nativeFrameBlocked === true);
          };
          window.addEventListener('message', listener);
          const frame = document.createElement('iframe'); frame.src = '/native-frame'; frame.hidden = true; document.body.append(frame);
        });
      } catch {}
      document.getElementById('permissions').textContent = nativePermissionsVerified && nativeFramesBlocked ? 'Native permissions verified' : 'Native permissions failed';
      await fetch('/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identityVerified,commandsBlocked,nativePermissionsVerified,nativeFramesBlocked})});
    })();</script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "lumiverse_ios_smoke=1; Max-Age=3600; Path=/; SameSite=Lax" } });
} });
try {
  const specPath = join(generated, "project.yml");
  let spec = readFileSync(specPath, "utf8");
  if (!spec.includes("  LumiverseClientSmoke:")) spec += `
  LumiverseClientSmoke:
    type: bundle.ui-testing
    platform: iOS
    sources: [../../../../tests]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: chat.lumiverse.ios.smoke
        GENERATE_INFOPLIST_FILE: YES
        IPHONEOS_DEPLOYMENT_TARGET: "17.0"
    dependencies:
      - target: lumiverse-ios-client_iOS
    scheme:
      testTargets: [LumiverseClientSmoke]
`;
  spec = spec.replace(/(PRODUCT_BUNDLE_IDENTIFIER: chat\.lumiverse\.ios\.smoke\n        GENERATE_INFOPLIST_FILE: YES\n)(?!        IPHONEOS_DEPLOYMENT_TARGET:)/,
    '$1        IPHONEOS_DEPLOYMENT_TARGET: "17.0"\n');
  if (spec !== readFileSync(specPath, "utf8")) {
    writeFileSync(specPath, spec);
    await run(["xcodegen", "generate", "--spec", "project.yml"]);
  }
  // A dedicated test simulator can be reset without touching the user's devices.
  await run(["xcrun", "simctl", "terminate", simulator, "chat.lumiverse.ios"]).catch(() => {});
  await run(["xcrun", "simctl", "uninstall", simulator, "chat.lumiverse.ios"]).catch(() => {});
  await run(["xcrun", "simctl", "privacy", simulator, "reset", "all", "chat.lumiverse.ios"]);
  const out = join(root, "dist/ios"); mkdirSync(out, { recursive: true });
  const resultBundle = join(out, `smoke-${Date.now()}.xcresult`);
  await run(["xcodebuild", "-quiet", "test", "-project", "lumiverse-ios-client.xcodeproj", "-scheme", "LumiverseClientSmoke",
    "-configuration", "debug", "-destination", `platform=iOS Simulator,id=${simulator}`,
    "-derivedDataPath", join(root, ".tmp/ios-xcode/simulator"), "-resultBundlePath", resultBundle,
    "CODE_SIGNING_ALLOWED=NO", "LUMIVERSE_IOS_EXPERIMENTAL_HIGH_REFRESH=0"]);
  if (!identityVerified || !commandsBlocked || !restoredCookie || !nativePermissionsVerified || !nativeFramesBlocked || !speechPermissionHandled)
    throw new Error("The remote page did not verify native identity, command isolation, permission bridge, frame isolation, and cookie persistence.");
  const report = { passed: true, simulator, identityVerified, commandsBlocked, restoredCookie, nativePermissionsVerified, nativeFramesBlocked, speechPermissionHandled, resultBundle,
    checks: ["server connection", "saved address across relaunch", "two-finger controls and native share sheet", "change server", "mobile identity", "remote command isolation", "persistent WebView cookies", "native permission bridge", "native subframe isolation", "native speech authorization and denial"],
    backend: "loopback fixture; live-server authentication and chat are not covered" };
  writeFileSync(join(out, "smoke-test.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("[ios] Ten client smoke checks passed.");
} finally { fixture.stop(true); }
