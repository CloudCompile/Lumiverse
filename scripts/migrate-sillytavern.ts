#!/usr/bin/env bun
/**
 * SillyTavern → Lumiverse Migration Tool
 *
 * Interactive CLI that walks users through importing characters, chats,
 * world books, and personas from a SillyTavern installation.
 *
 * Run with: bun run migrate:st
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, basename, extname, resolve } from "path";
import { createInterface } from "readline";
import {
  printBanner,
  printStepHeader,
  printSummary,
  printDivider,
  promptLabel,
  inputHint,
  theme,
} from "./ui";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const CHARACTER_BATCH_SIZE = 100;

// ─── Input helpers ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` ${inputHint(`(${defaultValue})`)}` : "";
  return new Promise((resolve) => {
    rl.question(`${promptLabel(question)}${hint} `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`${promptLabel(question)} `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let input = "";
    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === "\n" || c === "\r") {
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (c === "\u007F" || c === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (c === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else {
        input += c;
        process.stdout.write(`${theme.muted}*${theme.reset}`);
      }
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ─── Progress bar ───────────────────────────────────────────────────────────

function printProgress(label: string, current: number, total: number): void {
  const pct = total > 0 ? Math.round((current / total) * 100) : 100;
  const barWidth = 20;
  const filled = Math.round((current / Math.max(total, 1)) * barWidth);
  const empty = barWidth - filled;
  const bar = `${theme.secondary}${"=".repeat(filled)}${theme.muted}${" ".repeat(empty)}${theme.reset}`;
  process.stdout.write(`\r  [${bar}] ${pct}% ${label} (${current}/${total})   `);
}

function clearProgress(): void {
  process.stdout.write("\r" + " ".repeat(80) + "\r");
}

// ─── API helpers ────────────────────────────────────────────────────────────

let baseUrl = "";
let authCookie = "";

async function apiRequest(method: string, path: string, body?: any, formData?: FormData): Promise<any> {
  const url = `${baseUrl}/api/v1${path}`;
  const headers: Record<string, string> = {
    Cookie: authCookie,
  };

  let reqBody: BodyInit | undefined;

  if (formData) {
    reqBody = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    reqBody = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: reqBody });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${method} ${path} returned ${res.status}: ${text}`);
  }

  return res.json();
}

async function apiRequestWithRetry(method: string, path: string, body?: any, formData?: FormData): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await apiRequest(method, path, body, formData);
    } catch (err: any) {
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}

// ─── Date parsing ───────────────────────────────────────────────────────────

function parseDateString(value: string): number | null {
  // Strip @ characters ST sometimes uses in create_date ("2025-07-07@21h44m33s")
  let cleaned = value.replace(/@/g, " ").replace(/(\d+)h(\d+)m(\d+)s/, "$1:$2:$3").trim();

  // Numeric string (unix timestamp)
  const num = Number(cleaned);
  if (!isNaN(num) && cleaned.length > 0 && /^\d+(\.\d+)?$/.test(cleaned)) {
    if (num > 1_000_000_000_000) return Math.floor(num / 1000);
    if (num > 1_000_000_000) return Math.floor(num);
    return null; // too small to be a timestamp
  }

  // ST human-readable format: "July 7, 2025 9:44pm" — normalize am/pm for Date parser
  // Insert space before am/pm if missing: "9:44pm" → "9:44 PM"
  cleaned = cleaned.replace(/(\d)(am|pm)/i, "$1 $2").toUpperCase().replace(/ (AM|PM)/, " $1");

  const parsed = new Date(cleaned);
  if (!isNaN(parsed.getTime())) {
    return Math.floor(parsed.getTime() / 1000);
  }

  return null;
}

/**
 * Extract the best timestamp from an ST message object.
 * Priority: gen_started > gen_finished > send_date > fallback to now.
 */
function parseMessageDate(msg: any): number {
  // Prefer ISO 8601 machine timestamps from ST generation metadata
  for (const field of ["gen_started", "gen_finished"]) {
    const val = msg[field];
    if (typeof val === "string" && val.length > 0) {
      const ts = parseDateString(val);
      if (ts) return ts;
    }
  }

  // Fall back to send_date (human-readable in modern ST)
  const sendDate = msg.send_date;

  if (sendDate === undefined || sendDate === null) {
    return Math.floor(Date.now() / 1000);
  }

  if (typeof sendDate === "number") {
    if (sendDate > 1_000_000_000_000) return Math.floor(sendDate / 1000);
    if (sendDate > 1_000_000_000) return Math.floor(sendDate);
    return Math.floor(Date.now() / 1000);
  }

  if (typeof sendDate === "string") {
    const ts = parseDateString(sendDate);
    if (ts) return ts;
  }

  return Math.floor(Date.now() / 1000);
}

// ─── SillyTavern data scanning ──────────────────────────────────────────────

interface STDataCounts {
  characters: number;
  chatDirs: number;
  totalChatFiles: number;
  groupChats: number;
  groupChatFiles: number;
  worldBooks: number;
  personas: number;
}

function scanSTData(stDataDir: string): STDataCounts {
  const counts: STDataCounts = {
    characters: 0,
    chatDirs: 0,
    totalChatFiles: 0,
    groupChats: 0,
    groupChatFiles: 0,
    worldBooks: 0,
    personas: 0,
  };

  // Characters (PNG files)
  const charsDir = join(stDataDir, "characters");
  if (existsSync(charsDir)) {
    counts.characters = readdirSync(charsDir).filter(
      (f) => extname(f).toLowerCase() === ".png"
    ).length;
  }

  // Chats (JSONL files in subdirectories)
  const chatsDir = join(stDataDir, "chats");
  if (existsSync(chatsDir)) {
    const charDirs = readdirSync(chatsDir).filter((f) => {
      try {
        return statSync(join(chatsDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
    counts.chatDirs = charDirs.length;
    for (const dir of charDirs) {
      counts.totalChatFiles += readdirSync(join(chatsDir, dir)).filter(
        (f) => extname(f).toLowerCase() === ".jsonl"
      ).length;
    }
  }

  // Group chats (JSON definitions in groups/, JSONL files in group chats/)
  const groupsDir = join(stDataDir, "groups");
  if (existsSync(groupsDir)) {
    counts.groupChats = readdirSync(groupsDir).filter(
      (f) => extname(f).toLowerCase() === ".json"
    ).length;
  }
  const groupChatsDir = join(stDataDir, "group chats");
  if (existsSync(groupChatsDir)) {
    counts.groupChatFiles = readdirSync(groupChatsDir).filter(
      (f) => extname(f).toLowerCase() === ".jsonl"
    ).length;
  }

  // World books (JSON files)
  const worldsDir = join(stDataDir, "worlds");
  if (existsSync(worldsDir)) {
    counts.worldBooks = readdirSync(worldsDir).filter(
      (f) => extname(f).toLowerCase() === ".json"
    ).length;
  }

  // Personas from settings.json → power_user.personas / power_user.persona_descriptions
  const settingsPath = join(stDataDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const pu = settings.power_user || {};
      const allKeys = new Set([
        ...Object.keys(pu.personas || {}),
        ...Object.keys(pu.persona_descriptions || {}),
      ]);
      counts.personas = allKeys.size;
    } catch {
      // settings parse error, personas = 0
    }
  }

  return counts;
}

// ─── Import functions ───────────────────────────────────────────────────────

async function importCharacters(
  stDataDir: string
): Promise<{ imported: number; skipped: number; failed: number; filenameToId: Map<string, string> }> {
  const charsDir = join(stDataDir, "characters");
  // Maps PNG filename stem (e.g. "SomeChar") → Lumiverse character ID.
  // Chat directories in ST use the same filename stem, so this is the
  // key link between imported characters and their chat histories.
  const filenameToId = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  if (!existsSync(charsDir)) {
    return { imported, skipped, failed, filenameToId };
  }

  // Only .png files — ignore subdirectories (expression image folders)
  const pngFiles = readdirSync(charsDir).filter((f) => {
    if (extname(f).toLowerCase() !== ".png") return false;
    try {
      return statSync(join(charsDir, f)).isFile();
    } catch {
      return false;
    }
  });
  const total = pngFiles.length;

  // Batch into groups
  for (let batchStart = 0; batchStart < pngFiles.length; batchStart += CHARACTER_BATCH_SIZE) {
    const batch = pngFiles.slice(batchStart, batchStart + CHARACTER_BATCH_SIZE);
    const formData = new FormData();
    formData.set("skip_duplicates", "true");

    for (const filename of batch) {
      const filePath = join(charsDir, filename);
      try {
        const fileData = readFileSync(filePath);
        const blob = new Blob([fileData], { type: "image/png" });
        formData.append("files", blob, filename);
      } catch (err) {
        console.log(`\n    ${theme.warning}Could not read ${filename}, skipping${theme.reset}`);
        failed++;
      }
    }

    try {
      const result = await apiRequestWithRetry("POST", "/characters/import-bulk", undefined, formData);
      if (result.results) {
        for (const r of result.results) {
          // r.filename is the original PNG filename we sent
          const stem = basename(r.filename || "", ".png");

          if (r.skipped) {
            skipped++;
            // Character already exists — map the filename stem to the
            // existing character so chats can be correlated later.
            if (r.character?.id && stem) {
              filenameToId.set(stem, r.character.id);
            }
          } else if (r.success && r.character) {
            imported++;
            if (stem) filenameToId.set(stem, r.character.id);
          } else {
            failed++;
          }
        }
      }
    } catch (err: any) {
      console.log(`\n    ${theme.error}Batch import failed: ${err.message}${theme.reset}`);
      failed += batch.length;
    }

    printProgress("Importing characters", Math.min(batchStart + batch.length, total), total);
  }

  clearProgress();
  return { imported, skipped, failed, filenameToId };
}

async function importWorldBooks(
  stDataDir: string
): Promise<{ imported: number; failed: number; totalEntries: number; nameToId: Map<string, string> }> {
  const worldsDir = join(stDataDir, "worlds");
  const nameToId = new Map<string, string>();
  let imported = 0;
  let failed = 0;
  let totalEntries = 0;

  if (!existsSync(worldsDir)) {
    return { imported, failed, totalEntries, nameToId };
  }

  const jsonFiles = readdirSync(worldsDir).filter(
    (f) => extname(f).toLowerCase() === ".json"
  );
  const total = jsonFiles.length;

  // Collect all world books
  const worldBooks: Array<{ name?: string; description?: string; entries: any }> = [];

  for (let i = 0; i < jsonFiles.length; i++) {
    const filePath = join(worldsDir, jsonFiles[i]);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      worldBooks.push({
        name: data.name || data.originalName || basename(jsonFiles[i], ".json"),
        description: data.description || "",
        entries: data.entries || [],
      });
    } catch (err) {
      console.log(`\n    ${theme.warning}Could not parse ${jsonFiles[i]}, skipping${theme.reset}`);
      failed++;
    }
    printProgress("Reading world books", i + 1, total);
  }

  clearProgress();

  if (worldBooks.length > 0) {
    try {
      const result = await apiRequestWithRetry("POST", "/migrate/world-books", {
        world_books: worldBooks,
      });
      if (result.results) {
        for (const r of result.results) {
          if (r.success) {
            imported++;
            totalEntries += r.entry_count || 0;
            if (r.name && r.world_book_id) {
              nameToId.set(r.name, r.world_book_id);
            }
          } else {
            failed++;
          }
        }
      }
    } catch (err: any) {
      console.log(`\n    ${theme.error}World book import failed: ${err.message}${theme.reset}`);
      failed += worldBooks.length;
    }
  }

  return { imported, failed, totalEntries, nameToId };
}

async function importPersonas(
  stDataDir: string,
  worldBookNameToId: Map<string, string>
): Promise<{ imported: number; failed: number; avatarsUploaded: number }> {
  const settingsPath = join(stDataDir, "settings.json");
  let imported = 0;
  let failed = 0;
  let avatarsUploaded = 0;

  if (!existsSync(settingsPath)) {
    return { imported, failed, avatarsUploaded };
  }

  // ST stores persona data under power_user in settings.json:
  //   power_user.personas:             { "avatar.png": "Display Name", ... }
  //   power_user.persona_descriptions: { "avatar.png": { description, title, position, depth?, role?, lorebook? }, ... }
  // Both are keyed by avatar filename.
  let personaNames: Record<string, string>;
  let personaDescriptions: Record<string, any>;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const pu = settings.power_user || {};
    personaNames = pu.personas || {};
    personaDescriptions = pu.persona_descriptions || {};
  } catch {
    return { imported, failed, avatarsUploaded };
  }

  // Use persona_descriptions as the primary list (it has the richest data),
  // but pull the display name from the personas object.
  const allKeys = new Set([...Object.keys(personaDescriptions), ...Object.keys(personaNames)]);
  if (allKeys.size === 0) {
    return { imported, failed, avatarsUploaded };
  }

  const entries = Array.from(allKeys);

  const personas: Array<{ name: string; description?: string; title?: string; folder?: string; attached_world_book_id?: string; metadata?: Record<string, any> }> = [];

  for (const avatarKey of entries) {
    // Display name comes from the "personas" object; fall back to filename stem
    const name = personaNames[avatarKey] || basename(avatarKey, extname(avatarKey));
    const meta = personaDescriptions[avatarKey];
    const description = typeof meta === "string" ? meta : meta?.description || "";
    const title = typeof meta === "object" ? meta?.title || "" : "";

    // Resolve attached lorebook by name
    const lorebookName = typeof meta === "object" ? meta?.lorebook || "" : "";
    const attached_world_book_id = lorebookName ? worldBookNameToId.get(lorebookName) : undefined;

    personas.push({ name, description, title, attached_world_book_id });
  }

  const total = personas.length;
  printProgress("Importing personas", 0, total);

  try {
    const result = await apiRequestWithRetry("POST", "/migrate/personas", { personas });

    if (result.results) {
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        if (r.success) {
          imported++;

          // Try to upload avatar
          const avatarKey = entries[i];
          const avatarDir = join(stDataDir, "User Avatars");
          const avatarPath = join(avatarDir, avatarKey);

          if (existsSync(avatarPath) && r.persona_id) {
            try {
              const avatarData = readFileSync(avatarPath);
              const mimeType = avatarKey.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
              const blob = new Blob([avatarData], { type: mimeType });
              const formData = new FormData();
              formData.set("avatar", blob, avatarKey);

              await apiRequestWithRetry("POST", `/personas/${r.persona_id}/avatar`, undefined, formData);
              avatarsUploaded++;
            } catch {
              // Avatar upload failed, not critical
            }
          }
        } else {
          failed++;
        }
        printProgress("Importing personas", i + 1, total);
      }
    }
  } catch (err: any) {
    console.log(`\n    ${theme.error}Persona import failed: ${err.message}${theme.reset}`);
    failed += personas.length;
  }

  clearProgress();
  return { imported, failed, avatarsUploaded };
}

async function importChats(
  stDataDir: string,
  filenameToId: Map<string, string>
): Promise<{ imported: number; failed: number; totalMessages: number; skippedChars: number }> {
  const chatsDir = join(stDataDir, "chats");
  let imported = 0;
  let failed = 0;
  let totalMessages = 0;
  let skippedChars = 0;

  if (!existsSync(chatsDir)) {
    return { imported, failed, totalMessages, skippedChars };
  }

  const charDirs = readdirSync(chatsDir).filter((f) => {
    try {
      return statSync(join(chatsDir, f)).isDirectory();
    } catch {
      return false;
    }
  });

  let processedChats = 0;
  let totalChats = 0;

  // Count total JSONL files first
  for (const dir of charDirs) {
    totalChats += readdirSync(join(chatsDir, dir)).filter(
      (f) => extname(f).toLowerCase() === ".jsonl"
    ).length;
  }

  for (const charDirName of charDirs) {
    // ST chat directory names correspond to the PNG filename stem of the
    // character card, NOT the character's display name from the card metadata.
    const characterId = filenameToId.get(charDirName);

    if (!characterId) {
      // No matching character was imported for this directory — skip
      const chatFiles = readdirSync(join(chatsDir, charDirName)).filter(
        (f) => extname(f).toLowerCase() === ".jsonl"
      );
      skippedChars++;
      processedChats += chatFiles.length;
      console.log(`\n    ${theme.warning}No character found for "${charDirName}", skipping ${chatFiles.length} chat(s)${theme.reset}`);
      printProgress("Importing chats", processedChats, totalChats);
      continue;
    }

    const chatFiles = readdirSync(join(chatsDir, charDirName)).filter(
      (f) => extname(f).toLowerCase() === ".jsonl"
    );

    // Build chat import batch for this character
    const chatsPayload: Array<{
      name?: string;
      metadata?: Record<string, any>;
      created_at?: number;
      messages: Array<{
        is_user: boolean;
        name: string;
        content: string;
        send_date?: number;
        swipes?: string[];
        swipe_id?: number;
        extra?: Record<string, any>;
      }>;
    }> = [];

    for (const chatFile of chatFiles) {
      const filePath = join(chatsDir, charDirName, chatFile);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());

        if (lines.length === 0) {
          processedChats++;
          printProgress("Importing chats", processedChats, totalChats);
          continue;
        }

        // Line 0 is chat metadata in ST format — extract chat name
        let chatName = basename(chatFile, ".jsonl");
        let chatCreatedAt: number | undefined;
        try {
          const meta = JSON.parse(lines[0]);
          if (meta.chat_metadata || meta.user_name !== undefined) {
            // This is ST metadata line — skip it for messages
            chatName = meta.chat_metadata?.name || chatName;
            if (meta.create_date) {
              const ts = parseDateString(meta.create_date);
              if (ts) chatCreatedAt = ts;
            }
          }
        } catch {
          // Not valid JSON metadata, treat all lines as messages
        }

        // Parse messages — skip line 0 if it was metadata
        const startLine = (() => {
          try {
            const first = JSON.parse(lines[0]);
            // ST metadata lines have user_name or chat_metadata
            if (first.user_name !== undefined || first.chat_metadata) return 1;
          } catch { /* ignore */ }
          return 0;
        })();

        const messages: Array<{
          is_user: boolean;
          name: string;
          content: string;
          send_date?: number;
          swipes?: string[];
          swipe_id?: number;
          extra?: Record<string, any>;
        }> = [];

        for (let i = startLine; i < lines.length; i++) {
          try {
            const msg = JSON.parse(lines[i]);
            const content = msg.mes || msg.content || "";
            if (!content && !msg.name) continue;

            messages.push({
              is_user: !!msg.is_user,
              name: msg.name || (msg.is_user ? "User" : charDirName),
              content,
              send_date: parseMessageDate(msg),
              swipes: Array.isArray(msg.swipes) ? msg.swipes : undefined,
              swipe_id: typeof msg.swipe_id === "number" ? msg.swipe_id : undefined,
              extra: msg.extra || undefined,
            });
          } catch {
            // Skip unparseable lines
          }
        }

        if (messages.length > 0) {
          chatsPayload.push({
            name: chatName,
            created_at: chatCreatedAt,
            messages,
          });
        }

        processedChats++;
        printProgress("Importing chats", processedChats, totalChats);
      } catch (err) {
        console.log(`\n    ${theme.warning}Could not read ${chatFile}, skipping${theme.reset}`);
        failed++;
        processedChats++;
        printProgress("Importing chats", processedChats, totalChats);
      }
    }

    // Send batch for this character
    if (chatsPayload.length > 0) {
      try {
        const result = await apiRequestWithRetry("POST", "/migrate/chats", {
          character_id: characterId,
          character_name: charDirName,
          chats: chatsPayload,
        });
        if (result.results) {
          for (const r of result.results) {
            if (r.success) {
              imported++;
              totalMessages += r.message_count || 0;
            } else {
              failed++;
            }
          }
        }
      } catch (err: any) {
        console.log(`\n    ${theme.error}Chat import failed for "${charDirName}": ${err.message}${theme.reset}`);
        failed += chatsPayload.length;
      }
    }
  }

  clearProgress();
  return { imported, failed, totalMessages, skippedChars };
}

async function importGroupChats(
  stDataDir: string,
  filenameToId: Map<string, string>
): Promise<{ imported: number; failed: number; totalMessages: number; skippedGroups: number }> {
  const groupsDir = join(stDataDir, "groups");
  const groupChatsDir = join(stDataDir, "group chats");
  let imported = 0;
  let failed = 0;
  let totalMessages = 0;
  let skippedGroups = 0;

  if (!existsSync(groupsDir) || !existsSync(groupChatsDir)) {
    return { imported, failed, totalMessages, skippedGroups };
  }

  const groupFiles = readdirSync(groupsDir).filter(
    (f) => extname(f).toLowerCase() === ".json"
  );

  let processedChats = 0;
  let totalChatsToProcess = 0;

  // First pass: count total chat files across all groups
  for (const gf of groupFiles) {
    try {
      const group = JSON.parse(readFileSync(join(groupsDir, gf), "utf-8"));
      totalChatsToProcess += (group.chats || []).length;
    } catch { /* skip */ }
  }

  for (const groupFile of groupFiles) {
    let group: any;
    try {
      group = JSON.parse(readFileSync(join(groupsDir, groupFile), "utf-8"));
    } catch {
      failed++;
      continue;
    }

    const members: string[] = group.members || [];
    const groupName: string = group.name || "Imported Group Chat";
    const chatIds: string[] = group.chats || [];

    // Resolve member filenames to character IDs
    const memberCharIds: string[] = [];
    let missingMembers = false;
    for (const memberFile of members) {
      const stem = basename(memberFile, ".png");
      const charId = filenameToId.get(stem);
      if (charId) {
        memberCharIds.push(charId);
      } else {
        missingMembers = true;
      }
    }

    if (memberCharIds.length === 0) {
      skippedGroups++;
      processedChats += chatIds.length;
      console.log(`\n    ${theme.warning}No members found for group "${groupName}", skipping${theme.reset}`);
      printProgress("Importing group chats", processedChats, totalChatsToProcess);
      continue;
    }

    if (missingMembers) {
      console.log(`\n    ${theme.warning}Some members missing for "${groupName}", importing with available members${theme.reset}`);
    }

    // Import each chat file for this group
    for (const chatId of chatIds) {
      const chatFilePath = join(groupChatsDir, `${chatId}.jsonl`);
      if (!existsSync(chatFilePath)) {
        processedChats++;
        printProgress("Importing group chats", processedChats, totalChatsToProcess);
        continue;
      }

      try {
        const raw = readFileSync(chatFilePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());

        if (lines.length === 0) {
          processedChats++;
          printProgress("Importing group chats", processedChats, totalChatsToProcess);
          continue;
        }

        // Line 0 may be metadata
        let chatCreatedAt: number | undefined;
        try {
          const meta = JSON.parse(lines[0]);
          if (meta.chat_metadata || meta.user_name !== undefined) {
            if (meta.create_date) {
              const ts = parseDateString(meta.create_date);
              if (ts) chatCreatedAt = ts;
            }
          }
        } catch { /* ignore */ }

        const startLine = (() => {
          try {
            const first = JSON.parse(lines[0]);
            if (first.chat_metadata || first.user_name !== undefined) return 1;
          } catch { /* ignore */ }
          return 0;
        })();

        const messages: Array<{
          is_user: boolean;
          name: string;
          content: string;
          send_date?: number;
          swipes?: string[];
          swipe_id?: number;
          extra?: Record<string, any>;
        }> = [];

        for (let i = startLine; i < lines.length; i++) {
          try {
            const msg = JSON.parse(lines[i]);
            const content = msg.mes || msg.content || "";
            if (!content && !msg.name) continue;

            messages.push({
              is_user: !!msg.is_user,
              name: msg.name || (msg.is_user ? "User" : "Unknown"),
              content,
              send_date: parseMessageDate(msg),
              swipes: Array.isArray(msg.swipes) ? msg.swipes : undefined,
              swipe_id: typeof msg.swipe_id === "number" ? msg.swipe_id : undefined,
              extra: msg.extra || undefined,
            });
          } catch {
            // Skip unparseable lines
          }
        }

        if (messages.length === 0) {
          processedChats++;
          printProgress("Importing group chats", processedChats, totalChatsToProcess);
          continue;
        }

        // Use createChatRaw to create the group chat — first member as character_id,
        // metadata flags it as a group with all member IDs
        if (!chatCreatedAt && group.create_date) {
          const ts = parseDateString(group.create_date);
          if (ts) chatCreatedAt = ts;
        }

        const chatsPayload = [{
          name: groupName,
          created_at: chatCreatedAt,
          metadata: { group: true, character_ids: memberCharIds },
          messages,
        }];

        const result = await apiRequestWithRetry("POST", "/migrate/chats", {
          character_id: memberCharIds[0],
          character_name: groupName,
          chats: chatsPayload,
        });

        if (result.results) {
          for (const r of result.results) {
            if (r.success) {
              imported++;
              totalMessages += r.message_count || 0;
            } else {
              failed++;
            }
          }
        }
      } catch (err: any) {
        console.log(`\n    ${theme.warning}Failed to import group chat "${chatId}": ${err.message}${theme.reset}`);
        failed++;
      }

      processedChats++;
      printProgress("Importing group chats", processedChats, totalChatsToProcess);
    }
  }

  clearProgress();
  return { imported, failed, totalMessages, skippedGroups };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  printBanner("SillyTavern Migration Tool");
  printDivider();

  // ─── Step 1: Authentication ─────────────────────────────────────────────

  printStepHeader(1, 6, "Authentication", "Connect to your Lumiverse instance.");

  baseUrl = await ask("Lumiverse URL", "http://localhost:7860");
  // Remove trailing slash
  baseUrl = baseUrl.replace(/\/+$/, "");

  const username = await ask("Username");
  const password = await askSecret("Password");

  if (!username || !password) {
    console.log(`\n  ${theme.error}Username and password are required.${theme.reset}`);
    process.exit(1);
  }

  // Authenticate
  console.log(`\n  ${theme.muted}Authenticating...${theme.reset}`);

  // Try username@lumiverse.local first (BetterAuth username plugin pattern)
  const emailVariants = [
    `${username}@lumiverse.local`,
    username,
  ];

  let authenticated = false;

  for (const email of emailVariants) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        redirect: "manual",
      });

      const setCookie = res.headers.getSetCookie?.() || [];
      const sessionCookie = setCookie.find((c: string) => c.includes("better-auth.session_token"));

      if (sessionCookie) {
        // Extract full cookie value
        authCookie = sessionCookie.split(";")[0];
        authenticated = true;
        break;
      }

      // Also check response body for token
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.token) {
          authCookie = `better-auth.session_token=${body.token}`;
          authenticated = true;
          break;
        }
      }
    } catch {
      // Try next variant
    }
  }

  if (!authenticated) {
    console.log(`\n  ${theme.error}Authentication failed. Check your credentials and server URL.${theme.reset}`);
    process.exit(1);
  }

  // Verify auth works
  try {
    await apiRequest("GET", "/settings");
    console.log(`  ${theme.success}Authenticated successfully.${theme.reset}\n`);
  } catch {
    console.log(`\n  ${theme.error}Authentication token is invalid. Could not reach settings endpoint.${theme.reset}`);
    process.exit(1);
  }

  printDivider();

  // ─── Step 2: SillyTavern Directory ──────────────────────────────────────

  printStepHeader(2, 6, "SillyTavern Directory", "Point to your SillyTavern installation.");

  let stPath = await ask("SillyTavern path", "~/SillyTavern");
  stPath = stPath.replace(/^~/, homedir());
  stPath = resolve(stPath);

  if (!existsSync(stPath)) {
    console.log(`\n  ${theme.error}Directory not found: ${stPath}${theme.reset}`);
    process.exit(1);
  }

  const stUser = await ask("ST user directory", "default-user");
  const stDataDir = join(stPath, "data", stUser);

  // Also check public/ directory pattern (older ST installs)
  let effectiveDataDir = stDataDir;
  if (!existsSync(stDataDir)) {
    const altDir = join(stPath, "public", "characters")
      ? join(stPath, "public")
      : stDataDir;
    if (existsSync(join(stPath, "public", "characters"))) {
      effectiveDataDir = join(stPath, "public");
      console.log(`  ${theme.muted}Using legacy directory structure: public/${theme.reset}`);
    } else {
      console.log(`\n  ${theme.error}Data directory not found: ${stDataDir}${theme.reset}`);
      console.log(`  ${theme.muted}Expected: {ST path}/data/{user}/${theme.reset}`);
      process.exit(1);
    }
  }

  console.log(`\n  ${theme.muted}Scanning data...${theme.reset}`);
  const counts = scanSTData(effectiveDataDir);

  console.log(`\n  ${theme.bold}Found:${theme.reset}`);
  console.log(`    Characters:   ${theme.secondary}${counts.characters}${theme.reset} PNG files`);
  console.log(`    Chats:        ${theme.secondary}${counts.totalChatFiles}${theme.reset} files across ${counts.chatDirs} characters`);
  console.log(`    Group Chats:  ${theme.secondary}${counts.groupChatFiles}${theme.reset} files across ${counts.groupChats} groups`);
  console.log(`    World Books:  ${theme.secondary}${counts.worldBooks}${theme.reset} JSON files`);
  console.log(`    Personas:     ${theme.secondary}${counts.personas}${theme.reset} entries`);
  console.log("");

  if (counts.characters + counts.totalChatFiles + counts.groupChatFiles + counts.worldBooks + counts.personas === 0) {
    console.log(`  ${theme.warning}No data found to import.${theme.reset}`);
    rl.close();
    return;
  }

  printDivider();

  // ─── Step 3: Select What to Import ──────────────────────────────────────

  printStepHeader(3, 6, "Select Import Scope", "Choose what to migrate.");

  console.log("    1. Characters only");
  console.log("    2. World Books only");
  console.log("    3. Personas only");
  console.log("    4. Characters + Chat History (includes group chats)");
  console.log("    5. Everything");
  console.log("    6. Custom (select each)");
  console.log("");

  const choice = await ask("Selection", "5");

  let doCharacters = false;
  let doWorldBooks = false;
  let doPersonas = false;
  let doChats = false;
  let doGroupChats = false;

  switch (choice) {
    case "1":
      doCharacters = true;
      break;
    case "2":
      doWorldBooks = true;
      break;
    case "3":
      doPersonas = true;
      break;
    case "4":
      doCharacters = true;
      doChats = true;
      doGroupChats = true;
      break;
    case "5":
      doCharacters = true;
      doWorldBooks = true;
      doPersonas = true;
      doChats = true;
      doGroupChats = true;
      break;
    case "6": {
      const cAns = await ask("Import characters? (y/n)", "y");
      doCharacters = cAns.toLowerCase() === "y";
      const wAns = await ask("Import world books? (y/n)", "y");
      doWorldBooks = wAns.toLowerCase() === "y";
      const pAns = await ask("Import personas? (y/n)", "y");
      doPersonas = pAns.toLowerCase() === "y";
      const chAns = await ask("Import chat history? (y/n)", "y");
      doChats = chAns.toLowerCase() === "y";
      const gAns = await ask("Import group chats? (y/n)", "y");
      doGroupChats = gAns.toLowerCase() === "y";
      break;
    }
    default:
      doCharacters = true;
      doWorldBooks = true;
      doPersonas = true;
      doChats = true;
      doGroupChats = true;
  }

  // Warn if chats selected without characters
  if ((doChats || doGroupChats) && !doCharacters) {
    console.log(`\n  ${theme.warning}Chat import requires characters to exist in Lumiverse.${theme.reset}`);
    const addChars = await ask("Also import characters? (y/n)", "y");
    if (addChars.toLowerCase() === "y") {
      doCharacters = true;
    }
  }

  console.log("");
  printDivider();

  // ─── Step 4: Execute Import ─────────────────────────────────────────────

  printStepHeader(4, 6, "Importing", "This may take a while for large collections.");

  let charResult = { imported: 0, skipped: 0, failed: 0, filenameToId: new Map<string, string>() };
  let wbResult = { imported: 0, failed: 0, totalEntries: 0, nameToId: new Map<string, string>() };
  let personaResult = { imported: 0, failed: 0, avatarsUploaded: 0 };
  let chatResult = { imported: 0, failed: 0, totalMessages: 0, skippedChars: 0 };
  let groupChatResult = { imported: 0, failed: 0, totalMessages: 0, skippedGroups: 0 };

  // 1. Characters
  if (doCharacters && counts.characters > 0) {
    console.log(`\n  ${theme.bold}Characters${theme.reset}`);
    charResult = await importCharacters(effectiveDataDir);
    console.log(`  ${theme.success}Done:${theme.reset} ${charResult.imported} imported, ${charResult.skipped} skipped, ${charResult.failed} failed`);
  }

  // 2. World Books
  if (doWorldBooks && counts.worldBooks > 0) {
    console.log(`\n  ${theme.bold}World Books${theme.reset}`);
    wbResult = await importWorldBooks(effectiveDataDir);
    console.log(`  ${theme.success}Done:${theme.reset} ${wbResult.imported} imported (${wbResult.totalEntries} entries), ${wbResult.failed} failed`);
  }

  // 3. Personas
  if (doPersonas && counts.personas > 0) {
    console.log(`\n  ${theme.bold}Personas${theme.reset}`);
    personaResult = await importPersonas(effectiveDataDir, wbResult.nameToId);
    console.log(`  ${theme.success}Done:${theme.reset} ${personaResult.imported} imported, ${personaResult.failed} failed, ${personaResult.avatarsUploaded} avatars`);
  }

  // 4. Chats
  if (doChats && counts.totalChatFiles > 0) {
    console.log(`\n  ${theme.bold}Chat History${theme.reset}`);
    chatResult = await importChats(effectiveDataDir, charResult.filenameToId);
    console.log(`  ${theme.success}Done:${theme.reset} ${chatResult.imported} chats (${chatResult.totalMessages} messages), ${chatResult.failed} failed`);
    if (chatResult.skippedChars > 0) {
      console.log(`  ${theme.warning}${chatResult.skippedChars} character(s) not found — their chats were skipped${theme.reset}`);
    }
  }

  // 5. Group Chats
  if (doGroupChats && counts.groupChats > 0) {
    console.log(`\n  ${theme.bold}Group Chats${theme.reset}`);
    groupChatResult = await importGroupChats(effectiveDataDir, charResult.filenameToId);
    console.log(`  ${theme.success}Done:${theme.reset} ${groupChatResult.imported} chats (${groupChatResult.totalMessages} messages), ${groupChatResult.failed} failed`);
    if (groupChatResult.skippedGroups > 0) {
      console.log(`  ${theme.warning}${groupChatResult.skippedGroups} group(s) skipped — no members found${theme.reset}`);
    }
  }

  console.log("");
  printDivider();

  // ─── Step 5: Summary ────────────────────────────────────────────────────

  printStepHeader(5, 6, "Summary", "Migration results.");

  const summaryItems: Array<{ label: string; value: string }> = [];
  const warnings: string[] = [];

  if (doCharacters) {
    summaryItems.push({
      label: "Characters",
      value: `${charResult.imported} imported, ${charResult.skipped} skipped, ${charResult.failed} failed`,
    });
  }
  if (doWorldBooks) {
    summaryItems.push({
      label: "World Books",
      value: `${wbResult.imported} imported (${wbResult.totalEntries} entries), ${wbResult.failed} failed`,
    });
  }
  if (doPersonas) {
    summaryItems.push({
      label: "Personas",
      value: `${personaResult.imported} imported, ${personaResult.failed} failed`,
    });
  }
  if (doChats) {
    summaryItems.push({
      label: "Chats",
      value: `${chatResult.imported} imported (${chatResult.totalMessages} messages), ${chatResult.failed} failed`,
    });
  }
  if (doGroupChats && counts.groupChats > 0) {
    summaryItems.push({
      label: "Group Chats",
      value: `${groupChatResult.imported} imported (${groupChatResult.totalMessages} messages), ${groupChatResult.failed} failed`,
    });
  }

  const totalFailed =
    (doCharacters ? charResult.failed : 0) +
    (doWorldBooks ? wbResult.failed : 0) +
    (doPersonas ? personaResult.failed : 0) +
    (doChats ? chatResult.failed : 0) +
    (doGroupChats ? groupChatResult.failed : 0);

  if (totalFailed > 0) {
    warnings.push(`${totalFailed} item(s) failed to import. Check the output above for details.`);
  }

  printSummary("Migration Complete", summaryItems, warnings);

  // ─── Step 6: Post-Migration Notes ───────────────────────────────────────

  printStepHeader(6, 6, "Next Steps");

  console.log(`  ${theme.muted}1.${theme.reset} Refresh your Lumiverse browser tab to see imported content.`);
  console.log(`  ${theme.muted}2.${theme.reset} SillyTavern presets are not imported (architecture mismatch with Loom).`);
  console.log(`     Build new presets in Lumiverse's native preset system.`);
  console.log(`  ${theme.muted}3.${theme.reset} Your SillyTavern data has not been modified.`);
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error(`\n  ${theme.error}Migration failed:${theme.reset}`, err.message || err);
  rl.close();
  process.exit(1);
});
