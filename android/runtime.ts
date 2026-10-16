/** APK feasibility harness. Executes the real database and backend code without native-module shims. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { DatabaseExecutor } from "../src/db/execution";
import { initDatabase, closeDatabase } from "../src/db/connection";
import { runMigrations } from "../src/db/migrate";
import { hasConfiguredOwner } from "../src/runtime/bundle-setup";
import { configureAndroidOwner } from "./setup";

const root = resolve(import.meta.dir, "..");
const data = process.env.DATA_DIR;
if (!data || !process.env.LUMIVERSE_ANDROID_TOKEN) throw new Error("Launch through the Android host");
const token = process.env.LUMIVERSE_ANDROID_TOKEN;
delete process.env.LUMIVERSE_ANDROID_TOKEN;
const checkDirectory = join(data, "prototype-checks");
mkdirSync(checkDirectory, { recursive: true });
type Check = { name: string; state: "running" | "passed" | "failed"; detail: string };
const checks: Check[] = [];
const logs: string[] = [];
let checking = true;
let backend: ReturnType<typeof Bun.spawn> | undefined;
let backendState = "stopped";
let backendUrl = "";
let backendError = "";
let configured = hasConfiguredOwner(data);
let executor: DatabaseExecutor | undefined;
let stopping = false;

function log(text: string) {
  logs.push(text.slice(0, 4000));
  if (logs.length > 150) logs.shift();
}
async function check(name: string, action: () => Promise<string> | string) {
  const entry: Check = { name, state: "running", detail: "Checking…" }; checks.push(entry);
  try { entry.detail = await action(); entry.state = "passed"; }
  catch (error) { entry.detail = error instanceof Error ? error.message : String(error); entry.state = "failed"; }
}
async function diagnostics() {
  await check("Android Bun runtime", () => `${Bun.version} · ${process.platform}/${process.arch} · ${process.execPath}`);
  await check("Persistent SQLite storage", () => {
    const path = join(checkDirectory, "persistence.db");
    const db = new Database(path, { create: true });
    let count: number;
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS launches (id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
      db.run("INSERT INTO launches(at) VALUES (?)", [new Date().toISOString()]);
      count = (db.query("SELECT COUNT(*) AS count FROM launches").get() as { count: number }).count;
    } finally { db.close(); }
    const reopened = new Database(path);
    try {
      if ((reopened.query("SELECT COUNT(*) AS count FROM launches").get() as { count: number }).count !== count!)
        throw new Error("SQLite reopen did not preserve the write");
    } finally { reopened.close(); }
    return `${count!} recorded launches; reopened database successfully. ${path}`;
  });
  await check("Lumiverse schema migrations", async () => {
    const db = initDatabase(join(checkDirectory, "schema.db"));
    try { await runMigrations(db); return "The current backend schema migrated successfully."; }
    finally { closeDatabase(); }
  });
  await check("Lumiverse database subprocess", async () => {
    executor = new DatabaseExecutor(join(checkDirectory, "schema.db"), { transport: "stdio", deferBackgroundWork: true });
    try {
      await executor.execute({ kind: "transaction", statements: [
        { sql: "CREATE TABLE IF NOT EXISTS android_probe (value TEXT)" },
        { sql: "DELETE FROM android_probe" },
        { sql: "INSERT INTO android_probe VALUES (?)", bindings: ["apk-subprocess"] },
      ] });
      const result = await executor.execute<{ value: string }>({ kind: "read", statement: { sql: "SELECT value FROM android_probe", mode: "get" } });
      if (result.value !== "apk-subprocess") throw new Error("Subprocess read/write mismatch");
      return "Real DatabaseExecutor completed a transaction and read over stdio.";
    } finally { await executor.close(); executor = undefined; }
  });
  await check("Sharp image processing", async () => {
    const { default: sharp } = await import("sharp");
    const formats = ["png", "jpeg", "webp", "avif", "gif", "tiff", "jxl"] as const;
    for (const format of formats) {
      const encoded = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#8866cc" } })
        .resize(8, 8).toFormat(format).toBuffer();
      const metadata = await sharp(encoded).metadata();
      if (metadata.width !== 8 || metadata.height !== 8) throw new Error(`${format} round-trip failed`);
      const decoded = await sharp(encoded).raw().toBuffer({ resolveWithObject: true });
      if (decoded.info.width !== 8 || !decoded.data.length) throw new Error(`${format} pixel decode failed`);
    }
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="purple"/><text x="2" y="20" font-size="14">L</text></svg>');
    const rendered = await sharp(svg).resize(16, 16).webp().toBuffer();
    if ((await sharp(rendered).metadata()).width !== 16) throw new Error("SVG render failed");
    return `Sharp ${sharp.versions.sharp}/libvips ${sharp.versions.vips}: PNG, JPEG, WebP, AVIF, GIF, TIFF, JPEG XL round-trips and SVG rendering passed.`;
  });
  await check("FFmpeg media processing", async () => {
    const { checkAndroidFfmpeg } = await import("./ffmpeg-check");
    return checkAndroidFfmpeg();
  });
  await check("Git extension tools", async () => {
    const { checkAndroidGit } = await import("./git-check");
    return checkAndroidGit(join(checkDirectory, `git-${randomBytes(6).toString("hex")}`));
  });
  await check("LanceDB vector engine", async () => {
    const { checkLanceDb } = await import("../src/runtime/lancedb-check");
    await checkLanceDb(join(checkDirectory, `lance-${randomBytes(6).toString("hex")}`));
    return "Native vector search, full-text indexes, and reopening passed.";
  });
  await check("LanceDB concurrent commits", async () => {
    const { checkLanceConcurrency } = await import("./lance-concurrency");
    await checkLanceConcurrency(join(checkDirectory, `lance-concurrent-${randomBytes(6).toString("hex")}`));
    return "Two independent processes committed 16 additions; reopening retained all 17 rows.";
  });
  await check("Packaged frontend", async () => {
    if (!(await Bun.file(join(root, "frontend/dist/index.html")).text()).includes("<html")) throw new Error("Missing frontend");
    return "The existing production frontend is included in the APK.";
  });
  checking = false;
}

async function launchBackend(input: Record<string, unknown>) {
  if (backendState === "starting" || backendState === "running") throw new Error("The backend is already starting or running");
  // Reserve an available loopback port. Backend readiness is confirmed through private IPC.
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port; reservation.stop(true);
  backendState = "starting"; backendUrl = ""; backendError = "";
  try {
    if (!configured) {
      await configureAndroidOwner(data!, port, input);
      configured = true;
    }
  } catch (error) { backendState = "stopped"; throw error; }
  const readyToken = randomBytes(32).toString("hex");
  const childEnv = { ...process.env, PORT: String(port), LUMIVERSE_HOST: "127.0.0.1", FRONTEND_DIR: join(root, "frontend/dist"),
    LUMIVERSE_BUNDLE_READY_TOKEN: readyToken };
  try { backend = Bun.spawn([process.execPath, "--no-env-file", "--smol", join(root, "src/index.ts")], {
    cwd: root, env: childEnv, stdout: "pipe", stderr: "pipe",
    ipc(message) {
      if (message?.type === "bundle-ready" && message.token === readyToken) {
        backendState = "running";
        backendUrl = `http://127.0.0.1:${port}/`;
      }
    },
    onExit(_child, code) { backendState = `exited (${code})`; backendUrl = ""; backendError = "Please try again. Your local data is saved."; },
  }); } catch (error) { backendState = "stopped"; throw error; }
  const child = backend;
  async function drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; log(decoder.decode(value, { stream: true })); } }
    finally { reader.releaseLock(); }
  }
  void drain(child.stdout as ReadableStream<Uint8Array>).catch(error => log(String(error)));
  void drain(child.stderr as ReadableStream<Uint8Array>).catch(error => log(String(error)));
}

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 8192,
  async fetch(request, server) {
    const origin = `http://127.0.0.1:${server.port}`;
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
    if (request.headers.get("host") !== `127.0.0.1:${server.port}` ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin)) return json({ error: "Invalid origin" }, 403);
    if (request.method === "GET" && ["/", "/diagnostics"].includes(url.pathname)) return new Response(Bun.file(join(root, url.pathname === "/" ? "android/index.html" : "android/diagnostics.html")), {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" },
    });
    const supplied = Buffer.from(request.headers.get("x-lumiverse-prototype") || "");
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: "Invalid token" }, 403);
    if (request.method === "GET" && url.pathname === "/api/status") return json({
      checking, checks, dataDir: data, host: process.env.LUMIVERSE_ANDROID_HOST || "java", bundleId: process.env.LUMIVERSE_BUNDLE_ID,
      backendState, backendUrl, backendError, configured, logs,
    });
    try {
      if (request.method === "POST" && url.pathname === "/api/backend/start") {
        if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Expected JSON" }, 415);
        const input = await request.json();
        if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "Invalid setup" }, 400);
        await launchBackend(input); return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/backend/stop") {
        backend?.kill(); return json({ ok: true });
      }
    } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
    return json({ error: "Not found" }, 404);
  },
});
console.log(`LUMIVERSE_ANDROID_READY http://127.0.0.1:${server.port}/#${token}`);
// This process supervises the backend; the UI never waits for the probes.
if (configured) void launchBackend({}).catch(error => { backendError = String(error.message || error); log(backendError); });
void diagnostics().catch(error => { log(String(error)); checking = false; });
async function shutdown() {
  if (stopping) return; stopping = true;
  backend?.kill();
  await executor?.close();
  server.stop(true);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
