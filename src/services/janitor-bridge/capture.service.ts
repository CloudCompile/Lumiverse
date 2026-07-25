// ─────────────────────────────────────────────────────────────────────────────
// Janitor Bridge — Capture Service
//
// Responsibilities:
//   1. Extract V2 character card from an OpenAI-format chat completion request
//   2. Deduplicate by persona hash (same character → same Lumiverse character)
//   3. Save to Lumiverse's characters DB via characters.service.createCharacter
//   4. Track capture metadata (last chat timestamp, capture count, source URL)
//   5. Auto-tag on first save using the lexicon-based tag suggester
//
// Storage strategy:
//   - The V2 card data goes into Lumiverse's existing `characters` table
//   - Janitor-specific metadata (persona hash, source URL, chat count, etc.)
//     goes into the character's `extensions` field under the
//     `janitor_bridge` namespace — this is the documented Spindle convention
//     for extension-owned data.
//   - Dedup: when a card with the same `persona_hash` already exists, we
//     bump its `chat_count` and `last_chat_at` instead of creating a new one.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from "../../db/connection";
import * as charactersSvc from "../characters.service";
import {
  extractCard,
  hashPersona,
  type JanitorMessage,
  type V2Card,
} from "./parser";
import { autoTagCard } from "./tags";

// Extension namespace — must match the convention documented in
// developer-docs/docs/backend-api/characters.md ("Namespace your keys").
const NS = "janitor_bridge";

export interface CaptureResult {
  captured: boolean;
  characterId: string | null;
  personaHash: string | null;
  characterName: string | null;
  isNew: boolean;
  chatCount: number;
  reason?: string;
}

export interface CaptureOptions {
  /** Skip card extraction entirely (when bridge is in "passthrough" mode). */
  skipCapture?: boolean;
  /** Source URL of the original Janitor character page, if known. */
  sourceUrl?: string;
  /** Whether to apply auto-tagging on first save (default: true). */
  autoTag?: boolean;
}

/**
 * Find an existing captured character by persona hash.
 * Returns the Lumiverse character UUID, or null if not found.
 *
 * The persona hash is stored in `extensions.janitor_bridge.persona_hash`.
 * We use json_extract to reach into the JSON column.
 */
export function findCharacterByPersonaHash(
  userId: string,
  personaHash: string,
): string | null {
  const row = getDb()
    .query(
      `SELECT id FROM characters
       WHERE user_id = ?
         AND json_extract(extensions, '$.${NS}.persona_hash') = ?
       LIMIT 1`,
    )
    .get(userId, personaHash) as { id: string } | null;
  return row?.id ?? null;
}

/**
 * List all cards captured by the Janitor Bridge for a given user.
 * Returns rows ordered by last-chat-at desc (most recently chatted first).
 */
export interface CapturedCardRow {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  tags: string[];
  creator: string;
  image_id: string | null;
  created_at: number;
  updated_at: number;
  // janitor_bridge extension fields:
  persona_hash: string | null;
  source_url: string | null;
  chat_count: number;
  first_chat_at: number | null;
  last_chat_at: number | null;
  janitor_card_id: string | null;
}

export function listCapturedCards(
  userId: string,
  opts: { limit?: number; offset?: number; search?: string; tag?: string } = {},
): { data: CapturedCardRow[]; total: number } {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const where: string[] = [
    "user_id = ?",
    `json_extract(extensions, '$.${NS}.persona_hash') IS NOT NULL`,
  ];
  const params: any[] = [userId];

  if (opts.search) {
    where.push("(name LIKE ? OR description LIKE ?)");
    const like = `%${opts.search}%`;
    params.push(like, like);
  }
  if (opts.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value LIKE ?)");
    params.push(`%${opts.tag}%`);
  }

  const whereSql = where.join(" AND ");

  const totalRow = getDb()
    .query(`SELECT COUNT(*) as n FROM characters WHERE ${whereSql}`)
    .get(...params) as { n: number };

  const rows = getDb()
    .query(
      `SELECT id, name, description, personality, scenario, first_mes,
              tags, creator, image_id, created_at, updated_at, extensions
       FROM characters
       WHERE ${whereSql}
       ORDER BY COALESCE(json_extract(extensions, '$.${NS}.last_chat_at'), 0) DESC,
                updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as any[];

  const data: CapturedCardRow[] = rows.map((r) => {
    const ext = r.extensions ? JSON.parse(r.extensions) : {};
    const jb = ext[NS] || {};
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      personality: r.personality,
      scenario: r.scenario,
      first_mes: r.first_mes,
      tags: r.tags ? JSON.parse(r.tags) : [],
      creator: r.creator,
      image_id: r.image_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      persona_hash: jb.persona_hash ?? null,
      source_url: jb.source_url ?? null,
      chat_count: jb.chat_count ?? 0,
      first_chat_at: jb.first_chat_at ?? null,
      last_chat_at: jb.last_chat_at ?? null,
      janitor_card_id: jb.janitor_card_id ?? null,
    };
  });

  return { data, total: totalRow.n };
}

/**
 * Update the janitor_bridge extension metadata for an existing character.
 * Bumps chat_count, sets last_chat_at, optionally updates source_url.
 *
 * This is a shallow merge into the extensions object — preserves any other
 * extension keys that may have been set by Spindle extensions or Lumiverse
 * internals.
 */
export function bumpCaptureStats(
  userId: string,
  characterId: string,
  opts: { sourceUrl?: string; janitorCardId?: string } = {},
): void {
  const row = getDb()
    .query("SELECT extensions FROM characters WHERE id = ? AND user_id = ?")
    .get(characterId, userId) as { extensions: string } | null;
  if (!row) return;

  const ext = row.extensions ? JSON.parse(row.extensions) : {};
  const jb = ext[NS] || {};
  const now = Math.floor(Date.now() / 1000);

  ext[NS] = {
    ...jb,
    chat_count: (jb.chat_count ?? 0) + 1,
    last_chat_at: now,
    first_chat_at: jb.first_chat_at ?? now,
    source_url: opts.sourceUrl ?? jb.source_url ?? null,
    janitor_card_id: opts.janitorCardId ?? jb.janitor_card_id ?? null,
  };

  getDb()
    .query("UPDATE characters SET extensions = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(ext), now, characterId, userId);
}

/**
 * Attempt to capture a character card from an incoming OpenAI-format request.
 *
 * Safe to call on every chat completion request — returns early if no card
 * can be extracted, or if the user has disabled capture.
 *
 * @returns CaptureResult — what happened (for logging / UI feedback).
 */
export function captureFromRequest(
  userId: string,
  messages: JanitorMessage[],
  opts: CaptureOptions = {},
): CaptureResult {
  const empty: CaptureResult = {
    captured: false,
    characterId: null,
    personaHash: null,
    characterName: null,
    isNew: false,
    chatCount: 0,
    reason: opts.skipCapture ? "capture disabled" : "no card found",
  };

  if (opts.skipCapture) return empty;

  const card = extractCard(messages);
  if (!card || !card.data?.name) {
    return { ...empty, reason: "no card extractable from request" };
  }

  // Hash the persona for dedup. If hashPersona returns null (no persona block
  // detected — e.g. JSON-only card), fall back to hashing the name + description.
  const systemMsg = messages.find((m) => m.role === "system");
  const systemText = systemMsg
    ? (typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content))
    : "";
  const personaHash = hashPersona(systemText) || hashContent(`${card.data.name}|${card.data.description}`);

  const existingId = findCharacterByPersonaHash(userId, personaHash);
  if (existingId) {
    bumpCaptureStats(userId, existingId, {
      sourceUrl: opts.sourceUrl,
    });

    const row = getDb()
      .query("SELECT name FROM characters WHERE id = ? AND user_id = ?")
      .get(existingId, userId) as { name: string } | null;

    return {
      captured: true,
      characterId: existingId,
      personaHash,
      characterName: row?.name ?? card.data.name,
      isNew: false,
      chatCount: 0, // bumped, but we don't fetch the new value here
      reason: "existing card, stats bumped",
    };
  }

  // New capture: auto-tag, then create.
  const autoTagEnabled = opts.autoTag !== false;
  const tags = autoTagEnabled ? (autoTagCard(card, { max: 8 }) ?? []) : (card.data.tags ?? []);

  const created = charactersSvc.createCharacter(userId, {
    name: card.data.name,
    description: card.data.description,
    personality: card.data.personality,
    scenario: card.data.scenario,
    first_mes: card.data.first_mes,
    mes_example: card.data.mes_example,
    creator: card.data.creator || "captured via Janitor Bridge",
    creator_notes: card.data.creator_notes,
    system_prompt: card.data.system_prompt,
    post_history_instructions: card.data.post_history_instructions,
    tags,
    alternate_greetings: card.data.alternate_greetings ?? [],
    extensions: {
      [NS]: {
        persona_hash: personaHash,
        source_url: opts.sourceUrl ?? null,
        janitor_card_id: null,
        chat_count: 1,
        first_chat_at: Math.floor(Date.now() / 1000),
        last_chat_at: Math.floor(Date.now() / 1000),
        captured_from: "janitor_bridge",
        spec: card.spec,
        spec_version: card.spec_version,
      },
    },
  });

  return {
    captured: true,
    characterId: created.id,
    personaHash,
    characterName: created.name,
    isNew: true,
    chatCount: 1,
    reason: "new card created",
  };
}

// Re-export for internal use
function hashContent(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return Math.abs(hash).toString(36);
}
