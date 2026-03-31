import { getDb } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  DreamWeaverSession,
  CreateSessionInput,
  DW_DRAFT_V1,
  UpdateSessionInput,
} from "../../types/dream-weaver";
import { rawGenerate } from "../generate.service";
import * as connectionsSvc from "../connections.service";
import * as charactersSvc from "../characters.service";
import { DREAM_WEAVER_SYSTEM_PROMPT } from "./prompts";

const DREAM_WEAVER_REQUIRED_COLUMNS: Array<[name: string, definition: string]> = [
  ["dream_text", "TEXT NOT NULL DEFAULT ''"],
  ["tone", "TEXT"],
  ["constraints", "TEXT"],
  ["dislikes", "TEXT"],
  ["persona_id", "TEXT"],
  ["connection_id", "TEXT"],
  ["draft", "TEXT"],
  ["character_id", "TEXT"],
];

let dreamWeaverSchemaEnsured = false;

function createDreamWeaverTable(): void {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS dream_weaver_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      dream_text TEXT NOT NULL,
      tone TEXT,
      constraints TEXT,
      dislikes TEXT,
      persona_id TEXT,
      connection_id TEXT,
      draft TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      character_id TEXT,
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
      FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_user
      ON dream_weaver_sessions(user_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_status
      ON dream_weaver_sessions(user_id, status)
  `);
}

function ensureDreamWeaverSchema(): void {
  if (dreamWeaverSchemaEnsured) return;

  const db = getDb();
  const existingTable = db
    .query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'dream_weaver_sessions'
    `)
    .get() as { name: string } | null;

  if (!existingTable) {
    createDreamWeaverTable();
    dreamWeaverSchemaEnsured = true;
    return;
  }

  const columns = db.query("PRAGMA table_info(dream_weaver_sessions)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const hasLegacyDreamDescription = columnNames.has("dream_description");
  const hasLegacyDraftData = columnNames.has("draft_data");

  for (const [columnName, definition] of DREAM_WEAVER_REQUIRED_COLUMNS) {
    if (!columnNames.has(columnName)) {
      db.run(`ALTER TABLE dream_weaver_sessions ADD COLUMN ${columnName} ${definition}`);
    }
  }

  if (hasLegacyDreamDescription) {
    db.run(`
      UPDATE dream_weaver_sessions
      SET dream_text = COALESCE(NULLIF(dream_text, ''), NULLIF(dream_description, ''))
      WHERE COALESCE(dream_text, '') = ''
    `);
  }

  if (hasLegacyDraftData) {
    db.run(`
      UPDATE dream_weaver_sessions
      SET draft = CASE
        WHEN draft IS NULL OR draft = '' THEN NULLIF(draft_data, '{}')
        ELSE draft
      END
      WHERE draft IS NULL OR draft = ''
    `);
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_user
      ON dream_weaver_sessions(user_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_status
      ON dream_weaver_sessions(user_id, status)
  `);

  dreamWeaverSchemaEnsured = true;
}

function rowToSession(row: any): DreamWeaverSession {
  return {
    id: row.id,
    user_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dream_text: row.dream_text ?? "",
    tone: row.tone ?? null,
    constraints: row.constraints ?? null,
    dislikes: row.dislikes ?? null,
    persona_id: row.persona_id ?? null,
    connection_id: row.connection_id ?? null,
    draft: row.draft ?? null,
    status: row.status,
    character_id: row.character_id ?? null,
  };
}

function parseDraftResponse(content: string): DW_DRAFT_V1 {
  const trimmed = content.trim();
  const jsonContent = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  const draft = JSON.parse(jsonContent) as DW_DRAFT_V1;

  if (draft.format !== "DW_DRAFT_V1") {
    throw new Error("Dream Weaver returned an unexpected draft format");
  }

  return draft;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function serializeDraft(draft: DW_DRAFT_V1 | null | undefined): string | null {
  if (draft == null) return null;
  if (draft.format !== "DW_DRAFT_V1") {
    throw new Error("Dream Weaver draft payload is invalid");
  }
  return JSON.stringify(draft);
}

export function createSession(userId: string, input: CreateSessionInput): DreamWeaverSession {
  ensureDreamWeaverSchema();

  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const dreamText = input.dream_text.trim();

  if (!dreamText) {
    throw new Error("Dream text is required");
  }

  db.prepare(`
    INSERT INTO dream_weaver_sessions (
      id, user_id, created_at, updated_at,
      dream_text, tone, constraints, dislikes, persona_id, connection_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    now,
    now,
    dreamText,
    input.tone?.trim() || null,
    input.constraints?.trim() || null,
    input.dislikes?.trim() || null,
    input.persona_id || null,
    input.connection_id || null,
  );

  return getSession(userId, id)!;
}

export function getSession(userId: string, sessionId: string): DreamWeaverSession | null {
  ensureDreamWeaverSchema();

  const row = getDb().prepare(`
    SELECT *
    FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).get(sessionId, userId) as any;

  return row ? rowToSession(row) : null;
}

export function listSessions(userId: string): DreamWeaverSession[] {
  ensureDreamWeaverSchema();

  const rows = getDb().prepare(`
    SELECT *
    FROM dream_weaver_sessions
    WHERE user_id = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(userId) as any[];

  return rows.map(rowToSession);
}

export function updateSession(
  userId: string,
  sessionId: string,
  input: UpdateSessionInput,
): DreamWeaverSession {
  ensureDreamWeaverSchema();

  const existing = getSession(userId, sessionId);
  if (!existing) throw new Error("Session not found");

  const updates: string[] = [];
  const params: any[] = [];

  if ("dream_text" in input) {
    const dreamText = input.dream_text?.trim() ?? "";
    if (!dreamText) throw new Error("Dream text is required");
    updates.push("dream_text = ?");
    params.push(dreamText);
  }

  if ("tone" in input) {
    updates.push("tone = ?");
    params.push(normalizeOptionalText(input.tone));
  }

  if ("constraints" in input) {
    updates.push("constraints = ?");
    params.push(normalizeOptionalText(input.constraints));
  }

  if ("dislikes" in input) {
    updates.push("dislikes = ?");
    params.push(normalizeOptionalText(input.dislikes));
  }

  if ("persona_id" in input) {
    updates.push("persona_id = ?");
    params.push(normalizeOptionalText(input.persona_id));
  }

  if ("connection_id" in input) {
    updates.push("connection_id = ?");
    params.push(normalizeOptionalText(input.connection_id));
  }

  if ("draft" in input) {
    updates.push("draft = ?");
    params.push(serializeDraft(input.draft));
    updates.push("status = ?");
    params.push(input.draft ? "complete" : "draft");
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push("updated_at = ?");
  params.push(Math.floor(Date.now() / 1000));
  params.push(sessionId, userId);

  getDb().prepare(`
    UPDATE dream_weaver_sessions
    SET ${updates.join(", ")}
    WHERE id = ? AND user_id = ?
  `).run(...params);

  return getSession(userId, sessionId)!;
}

export async function generateDraft(userId: string, sessionId: string): Promise<DW_DRAFT_V1> {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    UPDATE dream_weaver_sessions
    SET status = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run("generating", now, sessionId, userId);

  eventBus.emit(EventType.DREAM_WEAVER_GENERATING, { sessionId }, userId);

  try {
    const connection = session.connection_id
      ? connectionsSvc.getConnection(userId, session.connection_id)
      : connectionsSvc.getDefaultConnection(userId);

    if (!connection) {
      throw new Error("No connection available");
    }

    const result = await rawGenerate(userId, {
      provider: connection.provider,
      model: connection.model,
      messages: [
        { role: "system", content: DREAM_WEAVER_SYSTEM_PROMPT },
        { role: "user", content: buildGenerationPrompt(session) },
      ],
      parameters: {
        temperature: 0.8,
        max_tokens: 8000,
      },
      connection_id: connection.id,
    });

    const draft = parseDraftResponse(result.content);

    db.prepare(`
      UPDATE dream_weaver_sessions
      SET draft = ?, status = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(JSON.stringify(draft), "complete", Math.floor(Date.now() / 1000), sessionId, userId);

    eventBus.emit(EventType.DREAM_WEAVER_COMPLETE, { sessionId }, userId);

    return draft;
  } catch (error) {
    db.prepare(`
      UPDATE dream_weaver_sessions
      SET status = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run("error", Math.floor(Date.now() / 1000), sessionId, userId);

    eventBus.emit(
      EventType.DREAM_WEAVER_ERROR,
      { sessionId, error: error instanceof Error ? error.message : String(error) },
      userId,
    );
    throw error;
  }
}

function buildGenerationPrompt(session: DreamWeaverSession): string {
  let prompt = `Dream: ${session.dream_text}`;

  if (session.tone) prompt += `\n\nTone: ${session.tone}`;
  if (session.constraints) prompt += `\n\nConstraints: ${session.constraints}`;
  if (session.dislikes) prompt += `\n\nHard No's (things to avoid): ${session.dislikes}`;

  return prompt;
}

export async function finalize(userId: string, sessionId: string): Promise<{ characterId: string }> {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  if (!session.draft) throw new Error("No draft to finalize");

  const draft = JSON.parse(session.draft) as DW_DRAFT_V1;
  const extensions: Record<string, unknown> = {
    alternate_fields: draft.alternate_fields,
    dream_weaver: {
      session_id: sessionId,
      kind: draft.kind,
      voice_guidance: draft.voice_guidance,
      appearance: draft.card.appearance,
    },
  };

  const character = charactersSvc.createCharacter(userId, {
    name: draft.card.name,
    description: draft.card.description,
    personality: draft.card.personality,
    scenario: draft.card.scenario,
    first_mes: draft.card.first_mes,
    system_prompt: draft.card.system_prompt,
    post_history_instructions: draft.card.post_history_instructions,
    tags: draft.meta.tags,
    alternate_greetings: draft.greetings.slice(1).map((greeting) => greeting.content),
    extensions,
  });

  getDb().prepare(`
    UPDATE dream_weaver_sessions
    SET character_id = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(character.id, Math.floor(Date.now() / 1000), sessionId, userId);

  return { characterId: character.id };
}

export function deleteSession(userId: string, sessionId: string): void {
  ensureDreamWeaverSchema();

  getDb().prepare(`
    DELETE FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).run(sessionId, userId);
}
