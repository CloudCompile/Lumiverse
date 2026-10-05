import { getDb } from "../../db/connection";
import { randomUUID } from "node:crypto";
import { rawGenerate } from "../generation/direct-generation";
import { resolveConnection } from "../connections.service";
import { resolveProviderAndKey } from "../generation/connection-resolution";
import { getTextContent, type GenerationResponse, type LlmMessage } from "../../llm/types";
import { buildInlineToolContinuation } from "../inline-tool-continuation";
import {
  CARD_AGENT_TOOL_DEFINITIONS,
  executeCardAgentTool,
  type CardAgentToolContext,
  type ToolActivity,
} from "./tools.service";
import * as proposalSvc from "./proposal.service";

/**
 * Card Agent sessions: a conversational agent that reads the character library
 * and proposes edits for human approval.
 *
 * The loop is a bounded model → tools → model cycle. It has no write tool, so
 * the worst outcome of a bad turn is a proposal the user rejects.
 */

/** Round cap. Each round is one provider call plus its tool executions. */
const MAX_TOOL_ROUNDS = 6;
/** Context guard: the transcript keeps the most recent turns only. */
const MAX_TRANSCRIPT_MESSAGES = 24;

export interface CardAgentSession {
  id: string;
  title: string;
  connection_id: string | null;
  model: string | null;
  scope_mode: "all" | "selection";
  scope_character_ids: string[];
  created_at: number;
  updated_at: number;
}

export interface CardAgentMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  tool_activity: ToolActivity[];
  created_at: number;
}

interface SessionRow {
  id: string;
  title: string;
  connection_id: string | null;
  model: string | null;
  scope_mode: string;
  scope_character_ids: string;
  created_at: number;
  updated_at: number;
}

function toSession(row: SessionRow): CardAgentSession {
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.scope_character_ids);
    if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    // A malformed scope column degrades to no accessible cards rather than
    // granting the whole library.
  }
  return {
    ...row,
    scope_mode: row.scope_mode === "selection" ? "selection" : "all",
    scope_character_ids: ids,
  };
}

export function createSession(
  userId: string,
  input: {
    title?: string;
    connectionId?: string | null;
    model?: string | null;
    scopeMode?: "all" | "selection";
    scopeCharacterIds?: string[];
  } = {},
): CardAgentSession {
  const id = randomUUID();
  getDb().run(
    `INSERT INTO card_agent_sessions
     (id, user_id, title, connection_id, model, scope_mode, scope_character_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      input.title?.trim() || "New session",
      input.connectionId ?? null,
      input.model ?? null,
      input.scopeMode === "selection" ? "selection" : "all",
      JSON.stringify(input.scopeCharacterIds ?? []),
    ],
  );
  const session = getSession(userId, id);
  if (!session) throw new Error("Failed to create session");
  return session;
}

export function getSession(userId: string, sessionId: string): CardAgentSession | null {
  const row = getDb()
    .query(
      `SELECT id, title, connection_id, model, scope_mode, scope_character_ids, created_at, updated_at
       FROM card_agent_sessions WHERE id = ? AND user_id = ?`,
    )
    .get(sessionId, userId) as SessionRow | null;
  return row ? toSession(row) : null;
}

export function listSessions(userId: string, limit = 50): CardAgentSession[] {
  const rows = getDb()
    .query(
      `SELECT id, title, connection_id, model, scope_mode, scope_character_ids, created_at, updated_at
       FROM card_agent_sessions WHERE user_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userId, limit) as SessionRow[];
  return rows.map(toSession);
}

export function updateSession(
  userId: string,
  sessionId: string,
  patch: Partial<Pick<CardAgentSession, "title" | "connection_id" | "model" | "scope_mode" | "scope_character_ids">>,
): CardAgentSession | null {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.title !== undefined) {
    fields.push("title = ?");
    values.push(patch.title.trim() || "New session");
  }
  if (patch.connection_id !== undefined) {
    fields.push("connection_id = ?");
    values.push(patch.connection_id);
  }
  if (patch.model !== undefined) {
    fields.push("model = ?");
    values.push(patch.model);
  }
  if (patch.scope_mode !== undefined) {
    fields.push("scope_mode = ?");
    values.push(patch.scope_mode);
  }
  if (patch.scope_character_ids !== undefined) {
    fields.push("scope_character_ids = ?");
    values.push(JSON.stringify(patch.scope_character_ids));
  }

  if (fields.length > 0) {
    fields.push("updated_at = unixepoch()");
    values.push(sessionId, userId);
    getDb().run(
      `UPDATE card_agent_sessions SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
      values as never[],
    );
  }

  return getSession(userId, sessionId);
}

/**
 * Delete a session and strand nothing behind it.
 *
 * Unreviewed proposals are rejected rather than orphaned, so the review queue
 * cannot fill with edits whose originating conversation is gone.
 */
export function deleteSession(userId: string, sessionId: string): boolean {
  proposalSvc.rejectProposalsForSession(userId, sessionId);
  const result = getDb().run(
    `DELETE FROM card_agent_sessions WHERE id = ? AND user_id = ?`,
    [sessionId, userId],
  );
  getDb().run(`DELETE FROM card_agent_messages WHERE session_id = ? AND user_id = ?`, [sessionId, userId]);
  return result.changes > 0;
}

export function listMessages(userId: string, sessionId: string): CardAgentMessage[] {
  const rows = getDb()
    .query(
      `SELECT id, role, content, tool_activity, created_at
       FROM card_agent_messages WHERE session_id = ? AND user_id = ?
       ORDER BY id ASC`,
    )
    .all(sessionId, userId) as Array<Omit<CardAgentMessage, "tool_activity"> & { tool_activity: string }>;

  return rows.map((row) => {
    let activity: ToolActivity[] = [];
    try {
      const parsed = JSON.parse(row.tool_activity);
      if (Array.isArray(parsed)) activity = parsed as ToolActivity[];
    } catch {
      // A corrupt activity blob must not make the transcript unreadable.
    }
    return { ...row, tool_activity: activity };
  });
}

function appendMessage(
  userId: string,
  sessionId: string,
  role: CardAgentMessage["role"],
  content: string,
  toolActivity: ToolActivity[] = [],
): void {
  getDb().run(
    `INSERT INTO card_agent_messages (session_id, user_id, role, content, tool_activity)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, userId, role, content, JSON.stringify(toolActivity)],
  );
  getDb().run(
    `UPDATE card_agent_sessions SET updated_at = unixepoch() WHERE id = ? AND user_id = ?`,
    [sessionId, userId],
  );
}

function buildSystemPrompt(session: CardAgentSession, scopedCount: number | null): string {
  const scopeLine = session.scope_mode === "selection"
    ? `You may only read and propose edits for a fixed set of ${scopedCount ?? 0} characters. Calls outside that set are refused.`
    : "You may read the user's entire character library.";

  return [
    "You are the Card Agent for a character-card library. You help the user inspect and improve existing character cards.",
    "",
    "## Hard rules",
    "- You cannot edit a card. `propose_card_edit` files a proposal that the user reviews and approves. Never claim you have changed anything.",
    "- Always `read_card` a character before proposing changes to it. A proposal must be grounded in what the card actually says.",
    "- In a proposal, `from` must be the exact current value you read, and `to` is your proposed replacement. Only include fields you are actually changing.",
    "- Prefer targeted edits over wholesale rewrites. Keep the card's established voice, premise, and specifics; do not flatten it into generic prose.",
    "- Search before reading. Reading every card is wasteful and will not fit in context.",
    "- When a change spans several cards, work card by card and file one proposal per card so each is reviewable on its own.",
    "",
    "## How to work",
    "1. Use `search_cards`, `list_tags`, and `find_similar_cards` to locate the relevant cards.",
    "2. Use `read_card` on the few that matter, requesting only the sections you need.",
    "3. Discuss what you found, then file proposals with `propose_card_edit` and a short rationale.",
    "4. Tell the user plainly which proposals are waiting for review.",
    "",
    `Scope: ${scopeLine}`,
  ].join("\n");
}

function toLlmMessages(session: CardAgentSession, history: CardAgentMessage[], scopedCount: number | null): LlmMessage[] {
  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt(session, scopedCount) },
  ];
  const recent = history.slice(-MAX_TRANSCRIPT_MESSAGES);
  for (const message of recent) {
    if (message.role === "system") continue;
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

export interface RunTurnResult {
  reply: string;
  toolActivity: ToolActivity[];
  proposals: proposalSvc.EditProposal[];
  rounds: number;
}

/**
 * Run one user turn to completion.
 *
 * Executes tool calls in a bounded loop and returns the final assistant text
 * plus everything the tools did. Proposals filed during the turn are returned
 * so the caller can surface them without a second query.
 */
export async function runTurn(
  userId: string,
  sessionId: string,
  userText: string,
  options: { signal?: AbortSignal } = {},
): Promise<RunTurnResult> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const trimmed = userText.trim();
  if (!trimmed) throw new Error("Message is empty");

  // Resolve the connection the same way Weaver does — the session stores a
  // connection id and model, never provider credentials.
  const conn = resolveConnection(userId, session.connection_id || undefined);
  if (!conn) throw new Error("This session has no connection configured");
  const model = session.model?.trim() || conn.model;
  if (!model) throw new Error("This session has no model configured");

  const scope = session.scope_mode === "selection" ? session.scope_character_ids : null;

  // Providers that round-trip reasoning across tool calls need a native
  // tool_use/tool_result continuation. Anthropic in particular breaks on a
  // structured turn without its thinking blocks, so it stays on the legacy
  // text path — the same rule generate.service applies to inline tools.
  const { provider } = await resolveProviderAndKey(userId, conn.id);
  const structured = provider.capabilities.interleavedThinking === true;

  appendMessage(userId, sessionId, "user", trimmed);

  const history = listMessages(userId, sessionId);
  const messages = toLlmMessages(session, history, scope ? scope.length : null);

  const ctx: CardAgentToolContext = { userId, sessionId, scope };
  const activity: ToolActivity[] = [];
  let rounds = 0;
  let finalText = "";

  while (rounds < MAX_TOOL_ROUNDS) {
    if (options.signal?.aborted) throw new Error("Cancelled");
    rounds++;

    const response: GenerationResponse = await rawGenerate(
      userId,
      {
        provider: conn.provider,
        model,
        connection_id: conn.id,
        messages,
        tools: CARD_AGENT_TOOL_DEFINITIONS,
        parameters: { temperature: 0.4 },
        signal: options.signal,
      },
      { origin: { kind: "sidecar", name: "Card Agent", operation: "generate" } },
    );

    const assistantText = getTextContent({ role: "assistant", content: response.content });
    const toolCalls = response.tool_calls ?? [];

    if (assistantText.trim()) finalText = assistantText.trim();

    // No tool calls means the turn is done.
    if (toolCalls.length === 0) {
      messages.push({ role: "assistant", content: response.content || assistantText });
      break;
    }

    const results: Array<{ callId: string; name: string; result: string; isError: boolean }> = [];
    for (const call of toolCalls) {
      const outcome = await executeCardAgentTool(ctx, call.name, call.args ?? {});
      activity.push({
        name: call.name,
        args: call.args ?? {},
        ok: outcome.ok,
        summary: outcome.summary,
      });
      results.push({
        callId: call.call_id,
        name: call.name,
        result: outcome.content,
        isError: !outcome.ok,
      });
    }

    // Round-trip the tool calls natively when the provider supports it, so
    // reasoning survives across rounds; the helper falls back to a text
    // summary otherwise. A turn whose round 1 succeeded is common enough that
    // this branch does the heavy lifting.
    const continuation = buildInlineToolContinuation({
      structured,
      legacyAssistantOutput: assistantText,
      roundContent: assistantText,
      roundReasoning: response.reasoning ?? "",
      toolCalls,
      results: results.map((r) => ({
        callId: r.callId,
        qualifiedName: r.name,
        toolName: r.name,
        toolDisplayName: r.name,
        result: r.result,
        isError: r.isError,
      })),
      thinkingBlocks: response.thinking_blocks,
      reasoningDetails: response.reasoning_details,
      thoughtSignature: response.thought_signature,
    });
    messages.push(...continuation);
  }

  if (rounds >= MAX_TOOL_ROUNDS && !finalText) {
    finalText = "I reached the tool-call limit for this turn. Here is where I got to — ask me to continue if you want me to keep going.";
  }

  appendMessage(userId, sessionId, "assistant", finalText, activity);

  const proposals = proposalSvc.listProposals(userId, { sessionId, status: "pending", limit: 200 });

  return { reply: finalText, toolActivity: activity, proposals, rounds };
}

export { MAX_TOOL_ROUNDS };