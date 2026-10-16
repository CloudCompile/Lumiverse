#!/usr/bin/env bun
/** Device-level smoke test. Requires an explicitly selected emulator and an installed debug APK. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { checkAndroidBackupRestore } from "./android-backup-smoke";

const args = process.argv.slice(2);
const serialIndex = args.indexOf("--serial");
const serial = serialIndex >= 0 ? args[serialIndex + 1] : undefined;
if (!serial?.startsWith("emulator-")) throw new Error("Select an emulator explicitly with --serial emulator-PORT");
const apkIndex = args.indexOf("--apk");
const apk = apkIndex >= 0 ? resolve(args[apkIndex + 1] || "") : undefined;
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex >= 0 ? resolve(args[reportIndex + 1] || "") : undefined;
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.HOME || "", "Library/Android/sdk");
const adb = join(sdk, "platform-tools/adb");
const app = "chat.lumiverse.prototype";
async function command(...args: string[]) {
  const child = Bun.spawn([adb, "-s", serial!, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${err || out}`);
  return out.trim();
}
async function evaluate<T>(expression: string, diagnostics = false, timeoutMs = 15000): Promise<T> {
  const pid = (await command("shell", "pidof", app)).split(" ")[0];
  const port = await command("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`);
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ title: string; webSocketDebuggerUrl: string }>;
    const page = diagnostics ? pages.find(page => page.title === "Lumiverse Android Prototype") : pages[0];
    if (!page) throw new Error("Diagnostics WebView is not ready");
    return await new Promise<T>((resolve, reject) => {
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => { socket.close(); reject(new Error("WebView evaluation timed out")); }, timeoutMs);
      const finish = () => { clearTimeout(timer); socket.close(); };
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      socket.onerror = () => { finish(); reject(new Error("WebView debugging connection failed")); };
      socket.onmessage = event => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== 1) return;
        finish();
        if (reply.error || reply.result?.exceptionDetails) reject(new Error(JSON.stringify(reply.error || reply.result.exceptionDetails)));
        else resolve(reply.result.result.value as T);
      };
    });
  } finally { await command("forward", "--remove", `tcp:${port}`); }
}
let runtimeConnection: { port: string; address: URL } | undefined;
async function closeRuntimeConnection() {
  if (runtimeConnection) await command("forward", "--remove", `tcp:${runtimeConnection.port}`);
  runtimeConnection = undefined;
}
async function runtimeApi(path: string, body?: object, authenticated = true): Promise<Response> {
  if (!runtimeConnection) {
    const address = new URL(await command("shell", "run-as", app, "cat", "cache/lumiverse-runtime-url"));
    assert.equal(address.hostname, "127.0.0.1");
    const port = await command("forward", "tcp:0", `tcp:${address.port}`);
    runtimeConnection = { port, address };
  }
  const { port, address } = runtimeConnection;
  return fetch(`http://127.0.0.1:${port}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: address.host, "content-type": "application/json",
      ...(authenticated ? { "x-lumiverse-prototype": address.hash.slice(1) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function runtimeStatus(): Promise<Status> {
  const response = await runtimeApi("status");
  assert.equal(response.status, 200);
  return response.json() as Promise<Status>;
}
interface Status {
  host: string;
  bundleId: string;
  checking: boolean;
  configured: boolean;
  checks: Array<{ name: string; state: string; detail: string }>;
  backendState: string;
  backendUrl: string;
  logs: string[];
  dataDir: string;
}
async function waitForStatus(): Promise<Status> {
  const deadline = Date.now() + 90000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await runtimeStatus();
      if (!status.checking) return status;
    } catch (error) { last = error; await closeRuntimeConnection(); }
    await Bun.sleep(1000);
  }
  throw new Error(`Diagnostics did not finish: ${last}`);
}
function launches(status: Status) {
  const check = status.checks.find(check => check.name === "Persistent SQLite storage");
  assert.equal(check?.state, "passed", check?.detail);
  const count = Number(check?.detail.match(/^(\d+) recorded launches/)?.[1]);
  assert.ok(count > 0);
  return count;
}
async function start() { await closeRuntimeConnection(); await command("shell", "am", "start", "-n", `${app}/.MainActivity`); }
await command("shell", "am", "force-stop", app);
await start();
const first = await waitForStatus();
function verifyStatus(status: Status) {
  if (args.includes("--require-tauri")) assert.equal(status.host, "tauri");
  for (const name of ["Android Bun runtime", "Persistent SQLite storage", "Lumiverse schema migrations", "Lumiverse database subprocess", "Packaged frontend",
    ...(args.includes("--require-native") ? ["Sharp image processing", "LanceDB vector engine", "LanceDB concurrent commits", "FFmpeg media processing", "Git extension tools"] : [])]) {
    const check = status.checks.find(check => check.name === name);
    assert.equal(check?.state, "passed", `${name}: ${check?.detail}`);
  }
}
verifyStatus(first);
let tauri: object | undefined;
if (args.includes("--require-tauri")) {
  tauri = await evaluate("window.__TAURI_INTERNALS__.invoke('mobile_host_info')");
  assert.deepEqual(tauri, { host: "tauri", version: "2.11.5", platform: "android" });
  assert.equal(await evaluate("window.__LUMIVERSE_MOBILE__ === true && document.documentElement.getAttribute('data-tauri-mobile') === 'android' && !document.documentElement.hasAttribute('data-tauri-desktop')"), true);
  // Only the read-only host-info command is permitted on the remote loopback page.
  assert.equal(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:fs|read_file',{path:'/data/local/tmp'}).then(()=>false,()=>true)"), true);
}
assert.match(first.dataDir, /^\/data\/(user\/\d+|data)\/chat\.lumiverse\.prototype\/files\/lumiverse\/data$/);
assert.equal((await runtimeApi("status", undefined, false)).status, 403);
assert.equal((await runtimeApi("backend/stop", {}, false)).status, 403);
await command("shell", "am", "force-stop", app);
await start();
const restarted = await waitForStatus();
verifyStatus(restarted);
assert.equal(launches(restarted), launches(first) + 1, "Force-stop/relaunch must preserve SQLite data");
let updated: Status | undefined;
if (apk) {
  await command("install", "--no-incremental", "-r", apk);
  await start();
  updated = await waitForStatus();
  verifyStatus(updated);
  assert.equal(launches(updated), launches(restarted) + 1, "APK update must preserve SQLite data");
  const manifest = await Bun.file(apk + ".json").json();
  assert.equal(updated.bundleId, manifest.payloadSha256, "Updated app must run the selected APK payload");
}
let backendAttempt: { state: string; output: string; http?: object; frontend?: object; backupRestore?: object; extensionInstall?: object; extensionInstalls?: object[]; automaticRelaunch?: boolean } | undefined;
if (args.includes("--attempt-backend")) {
  const testPassword = process.env.LUMIVERSE_ANDROID_TEST_PASSWORD || crypto.randomUUID() + crypto.randomUUID();
  const before = await runtimeStatus();
  if (!before.configured) {
    assert.equal(await evaluate("document.title === 'Lumiverse' && !!document.querySelector('#setup:not([hidden]) input[name=extensionStorageMiB]') && !document.getElementById('checks')"), true);
    await evaluate(`document.querySelector('input[name=username]').value='prototypecheck'; document.querySelector('input[name=password]').value=${JSON.stringify(testPassword)}; document.getElementById('setup').requestSubmit(); true`);
  }
  const deadline = Date.now() + 60000;
  let state: Status = updated || restarted;
  while (Date.now() < deadline) {
    state = await runtimeStatus();
    if (state.backendState === "running" || state.backendState.startsWith("exited")) break;
    await Bun.sleep(1000);
  }
  const nativeFailures = state.checks.some(check => ["Sharp image processing", "LanceDB vector engine"].includes(check.name) && check.state === "failed");
  if (nativeFailures) {
    assert.match(state.backendState, /^exited/, "Missing native dependencies must produce a visible backend failure");
    assert.match(state.logs.join(""), /sharp|native binding/i, "Backend output must identify the native dependency failure");
  } else assert.equal(state.backendState, "running");
  backendAttempt = { state: state.backendState, output: state.logs.join("") };
  if (state.backendState === "running") {
    const address = new URL(state.backendUrl);
    assert.equal(address.hostname, "127.0.0.1");
    const forwarded = await command("forward", "tcp:0", `tcp:${address.port}`);
    try {
      const request = (path: string) => fetch(`http://127.0.0.1:${forwarded}${path}`, { headers: { host: address.host } });
      const frontend = await request("/");
      assert.equal(frontend.status, 200);
      const html = await frontend.text();
      assert.match(html, /<html/);
      const assetPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
      assert.ok(assetPath?.startsWith("/assets/"), "Production frontend module must be served");
      const asset = await request(assetPath!);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") || "", /javascript/);
      const config = await request("/api/v1/runtime-config");
      assert.equal(config.status, 200);
      assert.equal(typeof (await config.json() as { safeThemeMode: boolean }).safeThemeMode, "boolean");
      const protectedApi = await request("/api/v1/characters");
      assert.equal(protectedApi.status, 401);
      backendAttempt.http = { frontend: frontend.status, javascript: asset.status, runtimeConfig: config.status, unauthenticatedApi: protectedApi.status };
    } finally { await command("forward", "--remove", `tcp:${forwarded}`); }
    if (args.includes("--require-tauri")) {
      let rendered = false;
      const renderDeadline = Date.now() + 45000;
      while (Date.now() < renderDeadline) {
        try {
          rendered = await evaluate<boolean>(`location.origin===${JSON.stringify(new URL(state.backendUrl).origin)} && !!document.getElementById('root')?.firstElementChild`, false);
          if (rendered) break;
        } catch { /* Navigation destroys the previous JavaScript context. */ }
        await Bun.sleep(1000);
      }
      assert.ok(rendered, "Production frontend must render inside Tauri automatically");
      assert.equal(await evaluate("window.__LUMIVERSE_MOBILE__ === true && document.documentElement.getAttribute('data-platform') === 'android' && !document.documentElement.hasAttribute('data-tauri-desktop')", false), true);
      assert.deepEqual(await evaluate("window.__TAURI_INTERNALS__.invoke('mobile_host_info')", false), tauri);
      const entry = await evaluate("document.querySelector('input[name=password]')?'login':'lumiverse'");
      const display = await command("shell", "dumpsys", "window", "displays");
      const statusBarBottom = Number(display.match(/type=statusBars frame=\[0,0\]\[\d+,(\d+)\] visible=true/)?.[1]);
      assert.ok(statusBarBottom > 0, "The emulator must have a visible status bar");
      const layoutPath = `/data/local/tmp/lumiverse-smoke-layout-${Date.now()}.xml`;
      // Some emulator images report a failing UIAutomator exit after writing
      // valid XML. Require a fresh, readable dump rather than that exit status.
      let dumpError: unknown;
      await command("shell", "uiautomator", "dump", layoutPath).catch(error => { dumpError = error; });
      let layout: string;
      try { layout = await command("shell", "cat", layoutPath); }
      catch { throw new Error(`Could not read native layout: ${dumpError}`); }
      finally { await command("shell", "rm", "-f", layoutPath); }
      const webView = layout.match(/<node\b[^>]*class="android\.webkit\.WebView"[^>]*>/)?.[0];
      const webViewTop = Number(webView?.match(/bounds="\[\d+,(\d+)\]/)?.[1]);
      assert.equal(webViewTop, statusBarBottom, "The WebView must clear the status bar exactly once");
      const safeArea = await evaluate<{ top: number; bottom: number }>(`(() => {const probe=document.createElement('div');probe.style.padding='env(safe-area-inset-top) 0 env(safe-area-inset-bottom)';document.body.append(probe);const style=getComputedStyle(probe);const result={top:parseFloat(style.paddingTop),bottom:parseFloat(style.paddingBottom)};probe.remove();return result;})()`);
      assert.deepEqual(safeArea, { top: 0, bottom: 0 }, "Native bar padding must not also become CSS safe-area padding");
      backendAttempt.frontend = { automaticNavigation: "passed", entry, platform: "android", desktopIntegrations: "disabled", tauriBridge: "working", insets: { statusBarBottom, webViewTop, cssSafeArea: safeArea } };
      if (args.includes("--restore-backup") || args.includes("--install-extension")) {
        assert.ok(!before.configured || process.env.LUMIVERSE_ANDROID_TEST_PASSWORD, "Set LUMIVERSE_ANDROID_TEST_PASSWORD for an existing prototypecheck account");
        assert.equal(await evaluate(`fetch('/api/auth/sign-in/username',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'prototypecheck',password:${JSON.stringify(testPassword)}})}).then(r=>r.status)`), 200);
        await evaluate("setTimeout(()=>location.reload(),50); true");
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          try { if (await evaluate("!!document.getElementById('root')?.firstElementChild && !document.querySelector('input[name=password]')")) break; }
          catch { /* Reload replaces the JavaScript context. */ }
          await Bun.sleep(500);
        }
        if (args.includes("--restore-backup")) backendAttempt.backupRestore = await checkAndroidBackupRestore(evaluate);
        for (const [index, arg] of args.entries()) {
          if (arg !== "--install-extension") continue;
          const url = args[index + 1];
          assert.ok(url?.startsWith("https://"), "Select an HTTPS extension repository for the disposable test account");
          const branches = await evaluate<{ httpStatus: number; branches?: string[]; error?: string }>(`fetch('/api/v1/spindle/branches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({github_url:${JSON.stringify(url)}})}).then(async r=>({...await r.json(),httpStatus:r.status}))`, false, 60000);
          assert.equal(branches.httpStatus, 200, branches.error);
          assert.ok(branches.branches?.length, "Bundled Git must list branches over verified HTTPS");
          const installed = await evaluate<{ httpStatus: number; id?: string; identifier?: string; version?: string; error?: string }>(`fetch('/api/v1/spindle/install',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({github_url:${JSON.stringify(url)}})}).then(async r=>({...await r.json(),httpStatus:r.status}))`, false, 180000);
          assert.equal(installed.httpStatus, 201, installed.error);
          assert.ok(installed.id && installed.identifier, "The extension must install through the real Git/dependency/build flow");
          const localBranches = await evaluate<{ current: string; branches: string[] }>(`fetch('/api/v1/spindle/${installed.id}/branches').then(r=>r.json())`);
          assert.ok(localBranches.branches.length);
          const repoEntries = (await command("shell", "run-as", app, "ls", `files/lumiverse/data/extensions/${installed.identifier}/repo`)).split(/\s+/);
          const frontend = await evaluate<{ status: number; bytes: number }>(`fetch('/api/v1/spindle/${installed.id}/frontend').then(async r=>({status:r.status,bytes:(await r.text()).length}))`);
          assert.equal(frontend.status, 200);
          assert.ok(frontend.bytes > 1000, "The extension frontend must be available");
          if (new URL(url).pathname.replace(/\/$/, "").toLowerCase() === "/kittyafterdark/palette") {
            assert.equal(installed.identifier, "theme_studio");
            assert.ok(!repoEntries.includes("node_modules"), "Palette's published bundles must install without invoking Bun for development dependencies");
          }
          backendAttempt.extensionInstall = { repository: url, identifier: installed.identifier, version: installed.version, branch: localBranches.current, httpsCloneAndInstall: "passed", nodeModulesPresent: repoEntries.includes("node_modules") };
          (backendAttempt.extensionInstalls ||= []).push({ ...backendAttempt.extensionInstall, frontend });
        }
      }
    }
    await command("shell", "am", "force-stop", app);
    await start();
    const relaunched = await waitForStatus();
    assert.equal(relaunched.configured, true);
    assert.equal(relaunched.backendState, "running", "Configured installs must start the backend automatically");
    assert.equal(await evaluate(`location.origin===${JSON.stringify(new URL(relaunched.backendUrl).origin)} && !document.getElementById('checks') && !document.getElementById('setup')`), true);
    backendAttempt.automaticRelaunch = true;
  }
}
await closeRuntimeConnection();
const report = { testedAt: new Date().toISOString(), androidVersion: await command("shell", "getprop", "ro.build.version.release"),
  apiLevel: await command("shell", "getprop", "ro.build.version.sdk"), host: first.host, tauri, checks: (updated || restarted).checks, dataDir: first.dataDir,
  bundleId: (updated || restarted).bundleId,
  apkSha256: apk && createHash("sha256").update(await Bun.file(apk).bytes()).digest("hex"),
  security: "Unauthenticated status and mutation rejected", launches: { initial: launches(first), restarted: launches(restarted), updated: updated && launches(updated) }, backendAttempt };
if (reportPath) await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
