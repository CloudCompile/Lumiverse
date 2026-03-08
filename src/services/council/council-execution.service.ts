import type {
  CouncilSettings,
  CouncilMember,
  CouncilToolResult,
  CouncilExecutionResult,
  CouncilToolDefinition,
} from "lumiverse-spindle-types";
import type { LlmMessage } from "../../llm/types";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { rawGenerate } from "../generate.service";
import * as chatsSvc from "../chats.service";
import * as charactersSvc from "../characters.service";
import * as personasSvc from "../personas.service";
import * as packsSvc from "../packs.service";
import * as connectionsSvc from "../connections.service";
import * as worldBooksSvc from "../world-books.service";
import { activateWorldInfo } from "../world-info-activation.service";
import { getCouncilSettings, getAvailableTools } from "./council-settings.service";
import { BUILTIN_TOOLS_MAP } from "./builtin-tools";
import { toolRegistry } from "../../spindle/tool-registry";
import { getWorkerHost } from "../../spindle/lifecycle";

const MAX_RETRIES = 3;

interface ExecuteInput {
  userId: string;
  chatId: string;
  personaId?: string;
  connectionId?: string;
  /** Pre-resolved settings — avoids re-fetching and ensures consistency with caller. */
  settings?: CouncilSettings;
  /** Abort signal — when fired, stops executing further council tools. */
  signal?: AbortSignal;
}

/**
 * Execute the full council cycle: roll dice per member, invoke sidecar LLM
 * for each tool, collect results, format deliberation block.
 */
export async function executeCouncil(
  input: ExecuteInput
): Promise<CouncilExecutionResult | null> {
  const settings = input.settings ?? getCouncilSettings(input.userId);

  if (!settings.councilMode || !settings.toolsSettings.enabled) {
    console.debug("[council] Skipped: councilMode=%s, toolsEnabled=%s", settings.councilMode, settings.toolsSettings.enabled);
    return null;
  }
  if (settings.members.length === 0) {
    console.debug("[council] Skipped: no members configured");
    return null;
  }

  const sidecar = settings.toolsSettings.sidecar;
  if (!sidecar.connectionProfileId || !sidecar.model) {
    console.warn("[council] Skipped: sidecar connection not configured (profileId=%s, model=%s)", sidecar.connectionProfileId, sidecar.model);
    return null;
  }

  // Verify the sidecar connection exists
  const sidecarConn = connectionsSvc.getConnection(input.userId, sidecar.connectionProfileId);
  if (!sidecarConn) {
    console.warn("[council] Skipped: sidecar connection profile '%s' not found", sidecar.connectionProfileId);
    return null;
  }

  const startTime = Date.now();
  const allResults: CouncilToolResult[] = [];
  const namedResults = new Map<string, string>();

  // Build available tools map
  const availableTools = new Map<string, CouncilToolDefinition>();
  for (const t of getAvailableTools(input.userId)) {
    availableTools.set(t.name, t);
  }

  // Roll dice for each member
  const activeMembers = settings.members.filter((m) => {
    if (m.tools.length === 0) return false;
    if (m.chance >= 100) return true;
    if (m.chance <= 0) return false;
    return Math.random() * 100 < m.chance;
  });

  if (activeMembers.length === 0) {
    console.debug("[council] Skipped: no members survived dice roll (total=%d)", settings.members.length);
    return null;
  }

  eventBus.emit(EventType.COUNCIL_STARTED, {
    chatId: input.chatId,
    memberCount: activeMembers.length,
  }, input.userId);

  // Build shared context once
  const contextMessages = buildContextMessages(input, settings);

  // Execute members sequentially (abort-aware)
  for (const member of activeMembers) {
    if (input.signal?.aborted) {
      console.debug("[council] Aborted before member '%s'", member.itemName);
      break;
    }

    const memberResults = await executeMemberTools(
      input,
      settings,
      member,
      availableTools,
      contextMessages,
      namedResults
    );
    allResults.push(...memberResults);

    let memberAvatarUrl: string | null = null;
    try {
      const item = packsSvc.getLumiaItem(input.userId, member.itemId);
      memberAvatarUrl = item?.avatar_url || null;
    } catch {
      // Item may not exist — fall back to null
    }

    eventBus.emit(EventType.COUNCIL_MEMBER_DONE, {
      chatId: input.chatId,
      memberId: member.id,
      memberName: member.itemName,
      memberItemId: member.itemId,
      memberAvatarUrl,
      results: memberResults,
    }, input.userId);
  }

  const deliberationBlock = formatDeliberation(allResults, availableTools);
  const totalDurationMs = Date.now() - startTime;

  const result: CouncilExecutionResult = {
    results: allResults,
    deliberationBlock,
    totalDurationMs,
  };

  eventBus.emit(EventType.COUNCIL_COMPLETED, {
    chatId: input.chatId,
    totalDurationMs,
    resultCount: allResults.length,
  }, input.userId);

  return result;
}

/** Execute all assigned tools for a single council member. */
async function executeMemberTools(
  input: ExecuteInput,
  settings: CouncilSettings,
  member: CouncilMember,
  tools: Map<string, CouncilToolDefinition>,
  contextMessages: LlmMessage[],
  namedResults: Map<string, string>
): Promise<CouncilToolResult[]> {
  const results: CouncilToolResult[] = [];
  const sidecar = settings.toolsSettings.sidecar;

  // Build member identity context
  const identityMsg = buildMemberIdentity(input.userId, member);

  for (const toolName of member.tools) {
    if (input.signal?.aborted) {
      console.debug("[council] Aborted before tool '%s' for member '%s'", toolName, member.itemName);
      break;
    }

    const toolDef = tools.get(toolName);
    if (!toolDef) continue;

    const toolStart = Date.now();
    let success = false;
    let content = "";
    let error: string | undefined;

    // Check if this tool belongs to an extension (route to worker instead of sidecar)
    const extToolReg = toolRegistry.getTool(toolName);
    const isExtensionTool = !!extToolReg?.extension_id;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (isExtensionTool) {
          content = await invokeExtensionToolViaWorker(
            extToolReg!.extension_id,
            toolName,
            {},
            settings.toolsSettings.timeoutMs
          );
        } else {
          content = await invokeSidecarTool(
            input.userId,
            sidecar,
            toolDef,
            member,
            identityMsg,
            contextMessages,
            settings.toolsSettings
          );
        }
        success = true;
        break;
      } catch (err: any) {
        error = err.message;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    const result: CouncilToolResult & { resultVariable?: string } = {
      memberId: member.id,
      memberName: member.itemName,
      toolName,
      toolDisplayName: toolDef.displayName,
      success,
      content,
      error: success ? undefined : error,
      durationMs: Date.now() - toolStart,
    };
    // Propagate resultVariable from tool definition so callers can extract named results
    if (toolDef.resultVariable) {
      result.resultVariable = toolDef.resultVariable;
    }
    results.push(result);

    // Store named result if applicable
    if (success && toolDef.resultVariable) {
      namedResults.set(toolDef.resultVariable, content);
    }
  }

  return results;
}

/** Route a tool call to the extension worker that registered it. */
async function invokeExtensionToolViaWorker(
  extensionId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<string> {
  const host = getWorkerHost(extensionId);
  if (!host) {
    throw new Error(`Extension worker '${extensionId}' is not running`);
  }
  return host.invokeExtensionTool(toolName, args, timeoutMs);
}

/** Call the sidecar LLM for a single tool. */
async function invokeSidecarTool(
  userId: string,
  sidecar: { connectionProfileId: string; model: string; temperature: number; topP: number; maxTokens: number },
  tool: CouncilToolDefinition,
  member: CouncilMember,
  identityMsg: string,
  contextMessages: LlmMessage[],
  toolsSettings: { maxWordsPerTool: number; timeoutMs: number }
): Promise<string> {
  const brevityNote =
    toolsSettings.maxWordsPerTool > 0
      ? `\n\nIMPORTANT: Keep your response under ${toolsSettings.maxWordsPerTool} words.`
      : "";

  const roleNote = member.role
    ? `\nYour role on the council is: ${member.role}`
    : "";

  const systemPrompt = `${identityMsg}${roleNote}

You are being asked to use the following analysis tool. Respond with your analysis directly — do not use JSON formatting.

## Tool: ${tool.displayName}
${tool.description}

${tool.prompt}${brevityNote}`;

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...contextMessages,
    { role: "user", content: `Please perform your ${tool.displayName} analysis on the story context provided above. Respond directly with your findings.` },
  ];

  // Resolve the connection to get the provider name
  const conn = connectionsSvc.getConnection(userId, sidecar.connectionProfileId);
  if (!conn) throw new Error("Sidecar connection not found");

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    messages,
    connection_id: sidecar.connectionProfileId,
    parameters: {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: sidecar.maxTokens,
    },
  });

  return response.content || "";
}

/** Build the shared context messages (chat history, character info, world info, etc.). */
function buildContextMessages(input: ExecuteInput, settings: CouncilSettings): LlmMessage[] {
  const msgs: LlmMessage[] = [];
  const ts = settings.toolsSettings;

  const chat = chatsSvc.getChat(input.userId, input.chatId);
  let character: ReturnType<typeof charactersSvc.getCharacter> = null;

  // Character info
  if (ts.includeCharacterInfo && chat) {
    character = charactersSvc.getCharacter(input.userId, chat.character_id);
    if (character) {
      const charInfo = [
        character.name && `Name: ${character.name}`,
        character.description && `Description: ${character.description}`,
        character.personality && `Personality: ${character.personality}`,
        character.scenario && `Scenario: ${character.scenario}`,
      ]
        .filter(Boolean)
        .join("\n");
      if (charInfo) {
        msgs.push({ role: "system", content: `## Character Information\n${charInfo}` });
      }
    }
  }

  // User persona
  const persona = ts.includeUserPersona
    ? personasSvc.resolvePersonaOrDefault(input.userId, input.personaId)
    : null;
  if (persona) {
    msgs.push({
      role: "system",
      content: `## User Persona\nName: ${persona.name}\n${persona.description || ""}`,
    });
  }

  // World info — run keyword activation on recent messages and inject entries
  if (ts.includeWorldInfo && chat) {
    if (!character) character = charactersSvc.getCharacter(input.userId, chat.character_id);
    const wiEntries = collectWorldInfoForCouncil(input.userId, character, persona);
    if (wiEntries.length > 0) {
      const allMessages = chatsSvc.getMessages(input.userId, input.chatId);
      const wiResult = activateWorldInfo({
        entries: wiEntries,
        messages: allMessages,
        chatTurn: allMessages.length,
        wiState: {},
      });
      if (wiResult.activatedEntries.length > 0) {
        const wiContent = wiResult.activatedEntries
          .map((e: any) => {
            const label = e.comment || e.key?.join(", ") || "entry";
            return `[${label}]: ${e.content}`;
          })
          .join("\n\n");
        msgs.push({ role: "system", content: `## Activated World Info\n${wiContent}` });
      }
    }
  }

  // Recent chat history (take last N messages from the full list)
  const allMessages = chatsSvc.getMessages(input.userId, input.chatId);
  const recentMessages = allMessages.slice(-ts.sidecarContextWindow);
  for (const msg of recentMessages) {
    msgs.push({
      role: msg.is_user ? "user" : "assistant",
      content: msg.content,
    });
  }

  return msgs;
}

/** Build the identity/personality context for a Lumia council member. */
function buildMemberIdentity(userId: string, member: CouncilMember): string {
  let identity = `You are a council member named "${member.itemName}".`;

  try {
    const item = packsSvc.getLumiaItem(userId, member.itemId);
    if (item) {
      const parts: string[] = [];
      if (item.definition) parts.push(`Definition: ${item.definition}`);
      if (item.personality) parts.push(`Personality: ${item.personality}`);
      if (item.behavior) parts.push(`Behavior: ${item.behavior}`);
      if (parts.length > 0) {
        identity += `\n\n## WHO YOU ARE\n${parts.join("\n\n")}`;
        identity += `\n\nYou MUST analyze everything through the lens of this identity. Your perspective is shaped by who you are. Be biased toward your nature.`;
      }
    }
  } catch {
    // Item may not exist — fall back to name-only identity
  }

  return identity;
}

/** Format tool results into the Markdown deliberation block. */
function formatDeliberation(
  results: CouncilToolResult[],
  tools: Map<string, CouncilToolDefinition>
): string {
  if (results.length === 0) {
    return "## Council Deliberation\n\nNo tools were executed for this generation.";
  }

  const lines: string[] = ["## Council Deliberation"];
  lines.push("");
  lines.push("The following contributions have been gathered from council members:");
  lines.push("");

  // Group results by member, excluding variable-only tools
  const byMember = new Map<string, CouncilToolResult[]>();
  for (const r of results) {
    if (!r.success) continue;
    const toolDef = tools.get(r.toolName);
    if (toolDef?.resultVariable && toolDef.storeInDeliberation === false) continue;

    const existing = byMember.get(r.memberName) || [];
    existing.push(r);
    byMember.set(r.memberName, existing);
  }

  for (const [memberName, memberResults] of byMember) {
    lines.push(`### **${memberName}** says:`);
    lines.push("");
    for (const r of memberResults) {
      lines.push(`**${r.toolDisplayName}:**`);
      lines.push(r.content);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  // Append deliberation instructions
  lines.push(DELIBERATION_INSTRUCTIONS);

  return lines.join("\n");
}

/** Collect world book entries from character + persona for council WI injection. */
function collectWorldInfoForCouncil(
  userId: string,
  character: ReturnType<typeof charactersSvc.getCharacter>,
  persona: ReturnType<typeof personasSvc.resolvePersonaOrDefault>,
): import("../../types/world-book").WorldBookEntry[] {
  const entries: import("../../types/world-book").WorldBookEntry[] = [];
  const charBookId = character?.extensions?.world_book_id as string | undefined;
  if (charBookId) entries.push(...worldBooksSvc.listEntries(userId, charBookId));
  if (persona?.attached_world_book_id) {
    entries.push(...worldBooksSvc.listEntries(userId, persona.attached_world_book_id));
  }
  return entries;
}

const DELIBERATION_INSTRUCTIONS = `## Council Deliberation Instructions

You have access to the contributions from your fellow council members above.

Your task:
1. Review each member's contributions carefully
2. Debate which suggestions have the most merit
3. Consider how different ideas might combine or conflict
4. Reach a consensus on the best path forward
5. In your OOC commentary, reflect this deliberation process

**CRITICAL - Chain of Thought for Deliberation:**
When reviewing suggestions, you MUST:
- **ALWAYS** attempt to integrate and accommodate ALL reasonable suggestions from council members
- Exhaustively consider how multiple ideas can coexist and complement each other
- Only reject or challenge a suggestion if it would create irreconcilable conflicts with established lore
- Default stance: "How can we make this work together?" rather than "Why won't this work?"
- If two suggestions seem to conflict, explore creative synthesis first before dismissing either

**Guidelines for Deliberation:**
- Reference specific contributions by name
- Build upon good ideas
- When challenging: only do so if the suggestion fundamentally breaks established lore beyond repair
- Find synthesis between competing ideas — this is the DEFAULT expectation
- Your final narrative output should reflect the consensus reached through generous integration

**Tone:** Professional but passionate. You are invested in telling the best possible story through collaborative synthesis.`;
