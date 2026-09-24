import type { ToolDefinition } from "../../llm/types";
import * as charactersSvc from "../characters.service";
import * as proposalSvc from "./proposal.service";
import * as revisionSvc from "./revision.service";
import { snapshotCharacter } from "./revision.service";
import type { Character } from "../../types/character";

/**
 * The Card Agent's tool set.
 *
 * Deliberately read-only plus `propose_card_edit`. There is intentionally no
 * tool that writes to a character: the agent's output is a proposal, and a
 * human applies it. Adding a write tool here would defeat the approval
 * boundary this feature is built around.
 */

/** Cap the text returned for any single field so one huge card can't blow the context. */
const MAX_FIELD_CHARS = 6000;
const MAX_SEARCH_RESULTS = 25;

export interface ToolActivity {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** One-line human-readable result summary for the UI transcript. */
  summary: string;
}

function clampText(value: string): string {
  if (value.length <= MAX_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_FIELD_CHARS)}\n…[truncated ${value.length - MAX_FIELD_CHARS} chars]`;
}

/** Resolve the ids the agent is allowed to touch. `null` means the whole library. */
export type ScopeCharacterIds = string[] | null;

function assertInScope(scope: ScopeCharacterIds, characterId: string): void {
  if (scope && !scope.includes(characterId)) {
    throw new Error("That character is outside this session's scope");
  }
}

export interface CardAgentToolContext {
  userId: string;
  sessionId: string;
  scope: ScopeCharacterIds;
}

export const CARD_AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "search_cards",
    description:
      "Search the user's character library. Returns compact summaries (id, name, tags, folder, short description), never full cards. Use this first to find which characters are relevant, then read_card for the few you need.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search over names, creators, and tags." },
        tags: { type: "array", items: { type: "string" }, description: "Only cards carrying all of these tags." },
        folder: { type: "string", description: "Restrict to a folder." },
        limit: { type: "number", description: "Max results (default 15, max 25)." },
      },
      required: [],
    },
  },
  {
    name: "read_card",
    description:
      "Read one character's full card content. Pass `sections` to fetch only specific fields (e.g. ['description','first_mes']) when you do not need the whole card.",
    parameters: {
      type: "object",
      properties: {
        characterId: { type: "string", description: "The character id from search_cards." },
        sections: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional subset of fields: name, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, folder.",
        },
      },
      required: ["characterId"],
    },
  },
  {
    name: "list_tags",
    description: "List every tag in the library with how many cards carry it. Useful for finding a coherent set of cards to work on.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_similar_cards",
    description:
      "Find cards with the same or a near-identical name. Use before creating anything, and to surface accidental duplicates.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name to check." },
        excludeCharacterId: { type: "string", description: "Optional id to exclude (the card being edited)." },
      },
      required: ["name"],
    },
  },
  {
    name: "propose_card_edit",
    description:
      "Propose a change to an existing character. This does NOT modify the card — it files a proposal the user reviews and approves. Only include the fields you are actually changing. Provide a short rationale.",
    parameters: {
      type: "object",
      properties: {
        characterId: { type: "string", description: "The character to edit." },
        changes: {
          type: "object",
          description:
            "Field map: { fieldName: { from: <current value>, to: <proposed value> } }. Only the fields being changed. `from` must be the value you just read.",
        },
        rationale: { type: "string", description: "One or two sentences on why this edit improves the card." },
      },
      required: ["characterId", "changes"],
    },
  },
];

/**
 * Execute one tool call.
 *
 * Always returns a string — errors are rendered into the result so the model
 * can correct itself rather than the whole turn failing.
 */
export async function executeCardAgentTool(
  ctx: CardAgentToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; summary: string; ok: boolean }> {
  try {
    switch (name) {
      case "search_cards":
        return searchCards(ctx, args);
      case "read_card":
        return readCard(ctx, args);
      case "list_tags":
        return listTags(ctx);
      case "find_similar_cards":
        return findSimilarCards(ctx, args);
      case "propose_card_edit":
        return proposeCardEdit(ctx, args);
      default:
        return { content: `Unknown tool "${name}".`, summary: "Unknown tool", ok: false };
    }
  } catch (err) {
    // Scope violations and unexpected failures surface as tool errors so the
    // model can see the refusal and adjust, rather than aborting the turn.
    const message = err instanceof Error ? err.message : "Tool failed";
    return { content: message, summary: "Refused", ok: false };
  }
}

function searchCards(ctx: CardAgentToolContext, args: Record<string, unknown>): { content: string; summary: string; ok: boolean } {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const folder = typeof args.folder === "string" ? args.folder.trim() : "";
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
    : [];
  const requested = typeof args.limit === "number" ? args.limit : Number(args.limit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SEARCH_RESULTS)
    : 15;

  // searchCards returns summaries only — full card text would not fit for a
  // library of any real size, which is the whole reason read_card exists.
  const result = charactersSvc.listCharacterSummaries(
    ctx.userId,
    { limit, offset: 0 },
    {
      search: query || undefined,
      tags: tags.length > 0 ? tags : undefined,
      filterMode: "all",
    },
  );

  let data = result.data;
  if (folder) data = data.filter((c) => c.folder === folder);
  if (ctx.scope) data = data.filter((c) => ctx.scope!.includes(c.id));

  if (data.length === 0) {
    return { content: "No characters matched.", summary: "0 matches", ok: true };
  }

  const lines = data.map((c) => {
    const preview = clampText(c.preview_description || c.description || "").replace(/\s+/g, " ").slice(0, 240);
    const tagList = c.tags?.length ? ` [${c.tags.join(", ")}]` : "";
    const folderLabel = c.folder ? ` (${c.folder})` : "";
    return `- id=${c.id} "${c.name}"${folderLabel}${tagList}\n  ${preview}`;
  });

  return {
    content: `${data.length} result(s):\n${lines.join("\n")}`,
    summary: `${data.length} match${data.length === 1 ? "" : "es"}`,
    ok: true,
  };
}

function readCard(ctx: CardAgentToolContext, args: Record<string, unknown>): { content: string; summary: string; ok: boolean } {
  const characterId = typeof args.characterId === "string" ? args.characterId.trim() : "";
  if (!characterId) return { content: "characterId is required.", summary: "Missing id", ok: false };
  assertInScope(ctx.scope, characterId);

  const character = charactersSvc.getCharacter(ctx.userId, characterId);
  if (!character) return { content: "No such character.", summary: "Not found", ok: false };

  const snapshot = snapshotCharacter(character) as unknown as Record<string, unknown>;
  const requested = Array.isArray(args.sections)
    ? args.sections.filter((s): s is string => typeof s === "string")
    : [];
  const fields = requested.length > 0
    ? requested.filter((f) => f in snapshot)
    : Object.keys(snapshot);

  const parts = fields.map((field) => {
    const value = snapshot[field];
    const rendered = Array.isArray(value)
      ? value.map((v, i) => `  [${i}] ${clampText(String(v))}`).join("\n")
      : clampText(String(value ?? ""));
    return `## ${field}\n${rendered}`;
  });

  return {
    content: `# ${character.name} (id=${character.id})\n\n${parts.join("\n\n")}`,
    summary: `${fields.length} field(s)`,
    ok: true,
  };
}

function listTags(ctx: CardAgentToolContext): { content: string; summary: string; ok: boolean } {
  const tags = charactersSvc.listCharacterTags(ctx.userId);
  if (tags.length === 0) return { content: "No tags in the library.", summary: "0 tags", ok: true };
  const lines = tags.map((t) => `- ${t.tag} (${t.count})`);
  return { content: `${tags.length} tag(s):\n${lines.join("\n")}`, summary: `${tags.length} tags`, ok: true };
}

function findSimilarCards(ctx: CardAgentToolContext, args: Record<string, unknown>): { content: string; summary: string; ok: boolean } {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { content: "name is required.", summary: "Missing name", ok: false };
  const exclude = typeof args.excludeCharacterId === "string" ? args.excludeCharacterId : "";

  const matches = charactersSvc
    .findCharactersByName(ctx.userId, name)
    .filter((c) => c.id !== exclude);

  if (matches.length === 0) return { content: "No cards share that name.", summary: "No duplicates", ok: true };

  const lines = matches.map((c) => `- id=${c.id} "${c.name}" (updated ${new Date(c.updated_at * 1000).toISOString().slice(0, 10)})`);
  return { content: `${matches.length} same-name card(s):\n${lines.join("\n")}`, summary: `${matches.length} duplicate(s)`, ok: true };
}

function proposeCardEdit(ctx: CardAgentToolContext, args: Record<string, unknown>): { content: string; summary: string; ok: boolean } {
  const characterId = typeof args.characterId === "string" ? args.characterId.trim() : "";
  if (!characterId) return { content: "characterId is required.", summary: "Missing id", ok: false };
  assertInScope(ctx.scope, characterId);

  const rawChanges = args.changes;
  if (!rawChanges || typeof rawChanges !== "object" || Array.isArray(rawChanges)) {
    return { content: "changes must be an object of { field: { from, to } }.", summary: "Bad changes", ok: false };
  }

  try {
    const proposal = proposalSvc.createProposal(ctx.userId, {
      characterId,
      changes: rawChanges as proposalSvc.ProposalChanges,
      rationale: typeof args.rationale === "string" ? args.rationale : null,
      sessionId: ctx.sessionId,
    });

    const fields = Object.keys(proposal.changes);
    return {
      content: `Proposal #${proposal.id} filed for "${proposal.character_name}" changing ${fields.length} field(s): ${fields.join(", ")}. It is pending user review — nothing has been modified yet.`,
      summary: `Proposed ${fields.length} field(s) on ${proposal.character_name}`,
      ok: true,
    };
  } catch (err) {
    return {
      content: `Could not file that proposal: ${err instanceof Error ? err.message : "unknown error"}`,
      summary: "Proposal rejected",
      ok: false,
    };
  }
}

/** Field names the agent may propose changes to — kept in sync with the revision service. */
export const CARD_AGENT_EDITABLE_FIELDS = revisionSvc.REVISION_FIELDS;

export type { Character };