import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBundleDirectories, parseBundleOptions, validateSettings, type ServerBundleManifest } from "../src/runtime/bundle";
import { extractServerBundle } from "../src/runtime/bundle-cache";
import { hasConfiguredOwner, startBundleSetup, type BundleSetup } from "../src/runtime/bundle-setup";
import { verifyPassword } from "../src/crypto/password";
import { collectBundleFiles, writeBundleArchive } from "../scripts/build-server";
import { JSDOM } from "jsdom";
import { BUNDLE_SETUP_PAGE } from "../src/runtime/bundle-setup-page";

const temporary: string[] = [];
const listeners: BundleSetup[] = [];
function directory(): string { const path = mkdtempSync(join(tmpdir(), "lumiverse-bundle-test-")); temporary.push(path); return path; }
afterEach(() => { for (const listener of listeners.splice(0)) listener.stop(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("server bundle runtime", () => {
  test("archives file bytes rather than empty file-backed blobs", async () => {
    const base = directory();
    writeFileSync(join(base, "binary.node"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(base, "entry.ts"), "console.log('payload')");
    const { files } = collectBundleFiles(base);
    const archive = join(base, "payload.tar.gz");
    await writeBundleArchive(archive, files);
    const bytes = await Bun.file(archive).bytes();
    expect([...bytes.slice(0, 2)]).toEqual([0x1f, 0x8b]);
    const restored = await new Bun.Archive(bytes).files();
    expect(await restored.get("entry.ts")!.text()).toBe("console.log('payload')");
    expect(await restored.get("binary.node")!.bytes()).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  test("keeps OS data locations independent of the launch directory", () => {
    expect(defaultBundleDirectories({}, "darwin", "/Users/alice").data).toBe("/Users/alice/Library/Application Support/Lumiverse/data");
    expect(defaultBundleDirectories({ LOCALAPPDATA: "C:\\Local" }, "win32", "C:\\Users\\alice").data).toBe("C:\\Local\\Lumiverse\\data");
    expect(defaultBundleDirectories({ XDG_DATA_HOME: "/data", XDG_CACHE_HOME: "/cache" }, "linux", "/home/alice")).toEqual({ data: "/data/lumiverse/data", cache: "/cache/lumiverse", config: "/home/alice/.config/lumiverse" });
  });

  test("rejects malformed port overrides and unknown launcher options", () => {
    for (const port of ["0", "65536", "123abc", "-1", "1.5"]) expect(() => parseBundleOptions(["--port", port])).toThrow();
    expect(() => parseBundleOptions(["--data-dir", "--check"])).toThrow();
    expect(() => parseBundleOptions(["--watch"])).toThrow();
    expect(() => validateSettings({ format: 1, dataDir: "/data", port: 7860, host: "" })).toThrow();
  });

  test("reports the configured data folder without extracting, initializing, or starting the server", async () => {
    const base = realpathSync(directory());
    const config = join(base, "config");
    const cache = join(base, "cache");
    const selected = join(base, "Old Lumiverse Δ");
    const launcher = join(base, "query.ts");
    const manifest: ServerBundleManifest = { format: 1, version: "test", bunVersion: Bun.version,
      platform: process.platform, arch: process.arch, branch: "staging", commit: "test",
      payloadSha256: "0".repeat(64), executableFiles: [], requiredFiles: [], ffmpeg: false };
    writeFileSync(launcher, `import { runBundledServer } from ${JSON.stringify(resolve(import.meta.dir, "../src/runtime/bundled-launcher.ts"))};\nawait runBundledServer("missing-archive", ${JSON.stringify(manifest)});\n`);
    const env = { ...process.env };
    for (const key of ["DATA_DIR", "PORT", "LUMIVERSE_HOST", "BUN_OPTIONS", "LUMIVERSE_CONFIG_DIR", "LUMIVERSE_CACHE_DIR"]) delete env[key];
    const query = async (extra: string[], overrides: Record<string, string> = {}) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", launcher, "--print-data-dir", "--config-dir", config, "--cache-dir", cache, ...extra],
        { cwd: base, env: { ...env, ...overrides }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(existsSync(cache)).toBe(false);
      return JSON.parse(stdout);
    };
    expect(await query(["--data-dir", selected])).toBe(selected);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(selected)).toBe(false);
    mkdirSync(config);
    const saved = JSON.stringify({ format: 1, dataDir: selected, port: 17860, host: "127.0.0.1" });
    writeFileSync(join(config, "server.json"), saved);
    expect(await query([])).toBe(selected);
    expect(await query([], { DATA_DIR: "environment-data" })).toBe(join(base, "environment-data"));
    expect(await query(["--data-dir", "cli-data"], { DATA_DIR: "environment-data" })).toBe(join(base, "cli-data"));
    expect(readFileSync(join(config, "server.json"), "utf8")).toBe(saved);
    expect(existsSync(selected)).toBe(false);
  });

  test("publishes a complete cache under concurrent extraction and rejects damaged archives", async () => {
    const base = directory();
    const bytes = await new Bun.Archive({ "src/index.ts": "console.log('fixture')", [`runtime/${process.platform === "win32" ? "bun.exe" : "bun"}`]: "runtime fixture" }).bytes();
    const archive = join(base, "app.tar");
    await Bun.write(archive, bytes);
    const manifest: ServerBundleManifest = { format: 1, version: "test", bunVersion: Bun.version,
      platform: process.platform, arch: process.arch, branch: "staging", commit: "test",
      payloadSha256: createHash("sha256").update(bytes).digest("hex"), executableFiles: [], requiredFiles: ["src/index.ts"], ffmpeg: false };
    const roots = await Promise.all([extractServerBundle(archive, manifest, base), extractServerBundle(archive, manifest, base)]);
    expect(roots[0]).toBe(roots[1]);
    expect(readFileSync(join(roots[0]!, "app/src/index.ts"), "utf8")).toContain("fixture");
    expect(await extractServerBundle("missing archive", manifest, base)).toBe(roots[0]);
    await expect(extractServerBundle(archive, { ...manifest, payloadSha256: "0".repeat(64) }, base)).rejects.toThrow("integrity");
    expect(existsSync(join(base, "server", "0".repeat(64)))).toBe(false);
  });
});

describe("bundled first-run setup", () => {
  function setup(base = directory()) {
    const dataDir = join(base, "data");
    const settingsPath = join(base, "server.json");
    const listener = startBundleSetup({ format: 1, dataDir, port: 7860, host: "127.0.0.1" }, settingsPath);
    listeners.push(listener);
    const link = new URL(listener.url);
    const token = link.hash.slice(1);
    const origin = link.origin;
    const body = { username: "owner", password: "bundle-test-password", dataDir, port: 17860, host: "127.0.0.1" };
    const post = (changes: object = {}, headers: Record<string, string> = {}) => fetch(origin + "/api/setup", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Lumiverse-Setup": token, Origin: origin, ...headers }, body: JSON.stringify({ ...body, ...changes }),
    });
    return { listener, dataDir, settingsPath, body, origin, token, post };
  }

  test("the browser form loads defaults, rejects mismatched passwords, and configures the server", async () => {
    const app = setup();
    let posted = 0;
    const page = new JSDOM(BUNDLE_SETUP_PAGE, { url: app.listener.url });
    // Bun's vm does not support jsdom's Proxy global. Execute the actual page
    // script with its DOM/browser APIs directly instead of jsdom's script runner.
    const browserFetch = (input: string, init?: RequestInit) => {
      if (init?.method === "POST") posted++;
      return fetch(new URL(input, app.origin), init);
    };
    new Function("window", "document", "location", "history", "sessionStorage", "fetch", "setTimeout",
      page.window.document.querySelector("script")!.textContent!)(page.window, page.window.document,
      page.window.location, page.window.history, page.window.sessionStorage, browserFetch, page.window.setTimeout.bind(page.window));
    const field = (name: string) => page.window.document.getElementById(name) as HTMLInputElement;
    const button = page.window.document.getElementById("submit") as HTMLButtonElement;
    const submit = () => page.window.document.getElementById("setup")!.dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(10); }
      throw new Error("Setup form did not finish updating");
    };
    try {
      await waitFor(() => !button.disabled);
      expect(field("dataDir").value).toBe(app.dataDir);
      expect(field("port").value).toBe("7860");
      expect(page.window.location.hash).toBe("");
      expect(page.window.sessionStorage.getItem("lumiverse.setup")).toBe(app.token);
      field("username").value = app.body.username;
      field("password").value = app.body.password;
      field("confirm").value = "different";
      submit();
      expect(page.window.document.getElementById("message")!.textContent).toContain("do not match");
      expect(posted).toBe(0);
      field("confirm").value = app.body.password;
      submit();
      expect(page.window.document.getElementById("title")!.textContent).toContain("server settings");
      expect(posted).toBe(0);
      field("port").value = "17860";
      submit();
      expect(page.window.document.getElementById("review-port")!.textContent).toBe("17860");
      page.window.document.getElementById("back")!.click();
      expect(field("port").value).toBe("17860");
      page.window.document.getElementById("back")!.click();
      expect(field("password").value).toBe(app.body.password);
      field("username").value = "changed_owner";
      submit();
      submit();
      expect(page.window.document.getElementById("review-username")!.textContent).toBe("changed_owner");
      expect(page.window.document.querySelector(".brand")!.textContent).toBe("Lumiverse · First launch");
      expect(page.window.document.querySelector("small")!.textContent).toContain("3–32");
      submit();
      await waitFor(() => page.window.document.getElementById("message")!.textContent!.includes("Starting Lumiverse"));
      expect(posted).toBe(1);
      expect((await app.listener.settings).dataDir).toBe(app.dataDir);
      expect(field("password").value).toBe("");
      expect(button.disabled).toBe(true);
    } finally { page.window.close(); }
  });

  test("requires a local origin and launch token, then stores only a password hash", async () => {
    const app = setup();
    expect((await app.post({}, { "X-Lumiverse-Setup": "wrong" })).status).toBe(403);
    expect((await app.post({}, { Origin: "https://example.com" })).status).toBe(403);
    expect((await app.post({ password: "short" })).status).toBe(400);
    expect(existsSync(join(app.dataDir, "owner.credentials"))).toBe(false);
    expect((await app.post()).status).toBe(200);
    expect((await app.listener.settings).port).toBe(17860);
    const credentials = JSON.parse(readFileSync(join(app.dataDir, "owner.credentials"), "utf8"));
    expect(await verifyPassword({ hash: credentials.passwordHash, password: app.body.password })).toBe(true);
    expect(readFileSync(app.settingsPath, "utf8")).not.toContain(app.body.password);
    expect((await app.post()).status).toBe(409);
    expect(hasConfiguredOwner(app.dataDir)).toBe(true);
  });

  test("does not overwrite an existing owner or remove another setup's lock", async () => {
    const app = setup();
    mkdirSync(app.dataDir);
    const lock = join(app.dataDir, ".bundle-setup.lock");
    writeFileSync(lock, "another process");
    expect((await app.post()).status).toBe(400);
    expect(readFileSync(lock, "utf8")).toBe("another process");
    rmSync(lock);
    writeFileSync(join(app.dataDir, "owner.credentials"), "existing");
    expect((await app.post()).status).toBe(400);
    expect(readFileSync(join(app.dataDir, "owner.credentials"), "utf8")).toBe("existing");
  });

  test("does not leave credentials behind when settings cannot be saved", async () => {
    const app = setup();
    mkdirSync(app.settingsPath);
    expect((await app.post()).status).toBe(400);
    expect(hasConfiguredOwner(app.dataDir)).toBe(false);
    expect(existsSync(join(app.dataDir, ".bundle-setup.lock"))).toBe(false);
  });
});
