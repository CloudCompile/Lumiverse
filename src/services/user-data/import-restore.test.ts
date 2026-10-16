import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { stopDatabaseExecution } from "../../db/execution";
import { initIdentity } from "../../crypto/init";
import { env } from "../../env";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { getSecret } from "../secrets.service";
import { startImport, submitTicket, type ImportJob } from "./import.service";
import { createManifest } from "./manifest";
import { createTicket, encryptSecret } from "./secret-ticket.service";

const USER = "restore-owner";
const IMAGE = "53b85311-27f6-4b99-9053-10f99879c058";
const CROP = "29dddaed-cfe1-4412-be94-3bf6015030d4";
const BACKGROUND = "bb0892c1-47cd-4e74-b8da-f36ead4d2621";
const originalDataDir = env.dataDir;
let directory: string;
let writer: Database | undefined;
let release: ReturnType<typeof setTimeout> | undefined;

beforeEach(async () => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lumiverse-import-restore-"));
  (env as { dataDir: string }).dataDir = directory;
  const db = initDatabase(join(directory, "lumiverse.db"));
  db.exec(await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text());
  db.query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
    .run(USER, "Restore", "restore@example.com");
  await initIdentity();
});

afterEach(async () => {
  if (release) clearTimeout(release);
  writer?.close(true);
  writer = undefined;
  await stopDatabaseExecution();
  closeDatabase();
  (env as { dataDir: string }).dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

async function waitFor(job: ImportJob, status: ImportJob["status"]) {
  const deadline = Date.now() + 5000;
  while (job.status !== status && !["complete", "failed", "cancelled"].includes(job.status) && Date.now() < deadline) await Bun.sleep(10);
  expect(job.error).toBeNull();
  expect(job.status).toBe(status);
}

function contend() {
  writer = new Database(join(directory, "lumiverse.db"));
  writer.exec("BEGIN IMMEDIATE");
  release = setTimeout(() => { writer!.exec("COMMIT"); }, 350);
}

async function archive(withSecrets: boolean) {
  const archiveId = crypto.randomUUID();
  const key = "connection_restored-connection_api_key";
  const ticket = await createTicket(archiveId, [key]);
  const manifest = createManifest({ archiveId, includeVectors: false, embeddingConfig: { provider: null, model: null, dimension: null },
    producerVersion: null, counts: {}, missingFiles: [], hasEncryptedSecrets: withSecrets });
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
  const rows = (values: unknown[]) => new TextEncoder().encode(values.map(value => JSON.stringify(value)).join("\n") + "\n");
  const entries: Record<string, Uint8Array> = {
    "manifest.json": encode(manifest),
    "database/images.ndjson": rows([IMAGE, CROP, BACKGROUND].map(id => ({ id, user_id: "source-owner", filename: `${id}.webp` }))),
    "database/characters.ndjson": encode({ id: "restored-character", name: "Character", image_id: IMAGE, user_id: "source-owner", extensions: JSON.stringify({ avatar_crop_image_id: CROP }) }),
    "database/personas.ndjson": encode({ id: "restored-persona", name: "Persona", avatar_path: "legacy-avatar.png", user_id: "source-owner" }),
    "database/chats.ndjson": encode({ id: "restored-chat", user_id: "source-owner", metadata: JSON.stringify({ wallpaper: { type: "image", image_id: BACKGROUND } }) }),
    "database/settings.ndjson": rows([
      { key: "wallpaper", user_id: "source-owner", value: JSON.stringify({ global: { type: "image", image_id: BACKGROUND } }) },
      { key: "activePersonaId", user_id: "source-owner", value: JSON.stringify("restored-persona") },
    ]),
    "database/connection_profiles.ndjson": encode({ id: "restored-connection", name: "Connection", provider: "openrouter", user_id: "source-owner" }),
    "files/avatars/legacy-avatar.png": new Uint8Array([1, 2, 3]),
  };
  for (const id of [IMAGE, CROP, BACKGROUND]) entries[`files/images/${id}.webp`] = new Uint8Array([4, 5, 6]);
  if (withSecrets) {
    entries["secrets/index.json"] = encode({ keys: [key] });
    entries["secrets/encrypted.ndjson"] = encode(await encryptSecret(ticket.smk, key, "restored-api-key"));
  }
  const archivePath = join(directory, "upload", "archive.lvbak");
  mkdirSync(join(directory, "upload"));
  writeFileSync(archivePath, zipSync(entries));
  return { archivePath, ticket: ticket.ticket, key };
}

test("restores original and cropped avatars, legacy avatar files, and wallpapers", async () => {
  const { archivePath } = await archive(false);
  getDb().query("INSERT INTO settings(key, value, user_id) VALUES ('wallpaper', ?, ?)")
    .run(JSON.stringify({ global: null, mobile: null, opacity: 1 }), USER);
  getDb().query("INSERT INTO settings(key, value, user_id) VALUES ('activePersonaId', 'null', ?)").run(USER);
  let publishedWithFiles = false;
  const emit = eventBus.emit.bind(eventBus);
  const publishing = spyOn(eventBus, "emit").mockImplementation((event, payload, userId, options) => {
    if (event === EventType.USER_IMPORT_PROGRESS && payload.phase === "table_done" && payload.table === "characters") {
      publishedWithFiles = readFileSync(join(directory, "images", `${IMAGE}.webp`)).length === 3;
    }
    emit(event, payload, userId, options);
  });
  const job = startImport({ userId: USER, archivePath, jobId: crypto.randomUUID() });
  try { await waitFor(job, "complete"); }
  finally { publishing.mockRestore(); }
  expect(publishedWithFiles).toBe(true);
  expect(job.fileSummary).toEqual({ avatars: 1, images: 3 });
  expect(getDb().query("SELECT image_id, extensions FROM characters WHERE id = 'restored-character'").get())
    .toEqual({ image_id: IMAGE, extensions: JSON.stringify({ avatar_crop_image_id: CROP }) });
  expect(JSON.parse((getDb().query("SELECT value FROM settings WHERE key = 'wallpaper' AND user_id = ?").get(USER) as { value: string }).value).global.image_id).toBe(BACKGROUND);
  expect(getDb().query("SELECT value FROM settings WHERE key = 'activePersonaId' AND user_id = ?").get(USER)).toEqual({ value: JSON.stringify("restored-persona") });
  for (const id of [IMAGE, CROP, BACKGROUND]) expect([...readFileSync(join(directory, "images", `${id}.webp`))]).toEqual([4, 5, 6]);
  expect([...readFileSync(join(directory, "avatars", "legacy-avatar.png"))]).toEqual([1, 2, 3]);
});

test("waits for a competing writer instead of abandoning table restoration", async () => {
  const { archivePath } = await archive(false);
  contend();
  const job = startImport({ userId: USER, archivePath, jobId: crypto.randomUUID() });
  await waitFor(job, "complete");
  expect(job.fileSummary.images).toBe(3);
});

test("accepts a ticket and restores its secrets while another process writes", async () => {
  const { archivePath, ticket, key } = await archive(true);
  const job = startImport({ userId: USER, archivePath, jobId: crypto.randomUUID() });
  await waitFor(job, "awaiting_ticket");
  contend();
  await submitTicket(job.jobId, ticket);
  const emit = eventBus.emit.bind(eventBus);
  const publishing = spyOn(eventBus, "emit").mockImplementation((event, payload, userId, options) => {
    if (event === EventType.USER_IMPORT_PROGRESS && payload.phase === "secrets_apply_start") {
      writer!.close(true);
      contend();
    }
    emit(event, payload, userId, options);
  });
  try { await waitFor(job, "complete"); }
  finally { publishing.mockRestore(); }
  expect(job.secretsRestored).toBe(1);
  expect(await getSecret(USER, key)).toBe("restored-api-key");
  expect(getDb().query("SELECT has_api_key FROM connection_profiles WHERE id = 'restored-connection'").get()).toEqual({ has_api_key: 1 });
});
