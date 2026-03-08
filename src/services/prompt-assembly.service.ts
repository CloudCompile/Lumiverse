import type { LlmMessage, AssemblyContext, AssemblyResult, AssemblyBreakdownEntry, GenerationType, ActivatedWorldInfoEntry } from "../llm/types";
import type { PromptBlock, PromptBehavior, CompletionSettings, SamplerOverrides, AuthorsNote } from "../types/preset";
import type { WorldInfoCache } from "../types/world-book";
import type { Character } from "../types/character";
import type { Persona } from "../types/persona";
import type { Chat } from "../types/chat";
import type { Message } from "../types/message";
import type { Preset } from "../types/preset";
import type { ConnectionProfile } from "../types/connection-profile";
import { evaluate, buildEnv, registry, initMacros } from "../macros";
import type { MacroEnv } from "../macros";
import { activateWorldInfo, type WiState } from "./world-info-activation.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as connectionsSvc from "./connections.service";
import * as presetsSvc from "./presets.service";
import * as worldBooksSvc from "./world-books.service";
import * as settingsSvc from "./settings.service";
import * as packsSvc from "./packs.service";
import * as embeddingsSvc from "./embeddings.service";
import { getCouncilSettings } from "./council/council-settings.service";

// ---------------------------------------------------------------------------
// Structural / content marker sets (mirrors frontend loom/constants.ts)
// ---------------------------------------------------------------------------

const STRUCTURAL_MARKERS = new Set([
  "chat_history",
  "world_info_before",
  "world_info_after",
  "char_description",
  "char_personality",
  "persona_description",
  "scenario",
  "dialogue_examples",
]);

const CONTENT_BEARING_MARKERS = new Set([
  "main_prompt",
  "enhance_definitions",
  "jailbreak",
  "nsfw_prompt",
]);

/** Maps structural markers to the macro that resolves their content. */
const MARKER_TO_MACRO: Record<string, string> = {
  char_description: "{{description}}",
  char_personality: "{{personality}}",
  persona_description: "{{persona}}",
  scenario: "{{scenario}}",
  dialogue_examples: "{{mesExamples}}",
};

/** Sampler override camelCase → API snake_case mapping. */
const SAMPLER_KEY_MAP: Record<string, string> = {
  maxTokens: "max_tokens",
  contextSize: "max_context_length",
  temperature: "temperature",
  topP: "top_p",
  minP: "min_p",
  topK: "top_k",
  frequencyPenalty: "frequency_penalty",
  presencePenalty: "presence_penalty",
  repetitionPenalty: "repetition_penalty",
};

interface GuidedGeneration {
  id: string;
  name: string;
  content: string;
  position: "system" | "user_prefix" | "user_suffix";
  mode: "persistent" | "oneshot";
  enabled: boolean;
}

function isAppendRole(role: string): boolean {
  return role === 'user_append' || role === 'assistant_append';
}

function appendBaseRole(role: string): 'user' | 'assistant' {
  return role === 'user_append' ? 'user' : 'assistant';
}

interface PendingAppend {
  baseRole: 'user' | 'assistant';
  depth: number;
  content: string;
  blockName: string;
  blockId: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Assemble the full LLM prompt from the Loom preset, character data,
 * persona, world info, and chat history.
 *
 * Falls back to legacy simple message mapping if no preset/blocks are found.
 */
export async function assemblePrompt(ctx: AssemblyContext): Promise<AssemblyResult> {
  // ---- Load data ----
  const chat = chatsSvc.getChat(ctx.userId, ctx.chatId);
  if (!chat) throw new Error("Chat not found");

  const messages = chatsSvc.getMessages(ctx.userId, ctx.chatId);
  // For group chats, resolve the target character; fall back to the chat's primary character
  const characterId = ctx.targetCharacterId || chat.character_id;
  const character = charactersSvc.getCharacter(ctx.userId, characterId);
  if (!character) throw new Error("Character not found");

  const persona = personasSvc.resolvePersonaOrDefault(ctx.userId, ctx.personaId);

  // Resolve connection
  const connection = ctx.connectionId
    ? connectionsSvc.getConnection(ctx.userId, ctx.connectionId)
    : connectionsSvc.getDefaultConnection(ctx.userId);

  // Resolve preset: request presetId takes priority, then connection's preset_id
  const resolvedPresetId = ctx.presetId || connection?.preset_id;
  let preset: Preset | null = null;
  if (resolvedPresetId) {
    preset = presetsSvc.getPreset(ctx.userId, resolvedPresetId);
  }

  // Extract Loom structures from preset
  const blocks: PromptBlock[] = preset?.prompt_order ?? [];
  const prompts = preset?.prompts ?? {};
  const promptBehavior: PromptBehavior = prompts.promptBehavior ?? {};
  const completionSettings: CompletionSettings = prompts.completionSettings ?? {};
  const samplerOverrides: SamplerOverrides | null = preset?.parameters?.samplerOverrides ?? null;

  // If no blocks, fall back to legacy mapping
  if (!blocks.length) {
    return await legacyAssembly(messages, ctx.generationType, character, persona, chat, connection, ctx.userId);
  }

  // ---- World Info activation ----
  const globalWorldBooks = (settingsSvc.getSetting(ctx.userId, "globalWorldBooks")?.value as string[] | undefined) ?? [];
  const wiSources = collectWorldInfoSources(ctx.userId, character, persona, globalWorldBooks);
  const wiEntries = wiSources.entries;
  const wiState: WiState = (chat.metadata?.wi_state as WiState) ?? {};
  const wiResult = activateWorldInfo({
    entries: wiEntries,
    messages,
    chatTurn: messages.length,
    wiState,
  });
  const wiCache = wiResult.cache;

  // Build activated world info summary (keyword-activated entries first)
  const activatedWorldInfo: ActivatedWorldInfoEntry[] = wiResult.activatedEntries.map((e) => ({
    id: e.id,
    comment: e.comment || '',
    keys: e.key || [],
    source: 'keyword' as const,
  }));

  // Optional vector retrieval for vectorized world book entries.
  // These entries are merged with keyword-activated entries when enabled.
  const vectorActivated = await collectVectorActivatedWorldInfo(
    ctx.userId,
    wiSources.worldBookIds,
    wiEntries,
    messages,
  );
  if (vectorActivated.length > 0) {
    const existing = new Set(wiResult.activatedEntries.map((e) => e.id));
    for (const { entry, score } of vectorActivated) {
      if (existing.has(entry.id)) continue;
      injectEntryIntoCache(wiCache, entry);
      wiResult.activatedEntries.push(entry);
      existing.add(entry.id);
      activatedWorldInfo.push({
        id: entry.id,
        comment: entry.comment || '',
        keys: entry.key || [],
        source: 'vector',
        score,
      });
    }
  }

  // ---- Defer WI state persistence to after generation ----
  const deferredWiState = {
    chatId: chat.id,
    metadata: { ...chat.metadata, wi_state: wiResult.wiState },
  };

  // ---- Macro engine ----
  initMacros();
  const macroEnv: MacroEnv = buildEnv({
    character,
    persona,
    chat,
    messages,
    generationType: ctx.generationType,
    connection,
  });

  // Batch-load all settings needed for assembly in a single query
  const settingsKeys = [
    "reasoningSettings",
    "selectedDefinition", "selectedBehaviors", "selectedPersonalities",
    "chimeraMode", "lumiaQuirks", "lumiaQuirksEnabled",
    "oocEnabled", "lumiaOOCInterval", "lumiaOOCStyle",
    "sovereignHand",
    "selectedLoomStyles", "selectedLoomUtils", "selectedLoomRetrofits",
    "guidedGenerations", "promptBias",
  ];
  const settingsMap = settingsSvc.getSettingsByKeys(ctx.userId, settingsKeys);

  // Populate reasoning macros from user settings
  const reasoningVal = settingsMap.get("reasoningSettings");
  if (reasoningVal) {
    macroEnv.extra.reasoningPrefix = reasoningVal.prefix ?? "";
    macroEnv.extra.reasoningSuffix = reasoningVal.suffix ?? "";
  }

  // Populate Lumia / Loom / Council / OOC / Sovereign Hand context for macros
  populateLumiaLoomContext(macroEnv, ctx.userId, chat, ctx, settingsMap);

  // ---- Assembly loop ----
  const result: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];
  const pendingAppends: PendingAppend[] = [];
  let chatHistoryInserted = false;
  let hasWiBefore = false;
  let hasWiAfter = false;
  let firstChatIdx = -1;

  for (const block of blocks) {
    // Skip disabled blocks
    if (!block.enabled) continue;

    // Skip category markers only if they carry no content
    if (block.marker === "category" && !block.content?.trim()) continue;

    // Injection trigger filtering — if block specifies triggers, skip if current
    // generation type is not in the list
    if (block.injectionTrigger && block.injectionTrigger.length > 0) {
      if (!block.injectionTrigger.includes(ctx.generationType)) continue;
    }

    // ---- Handle by marker type ----

    if (block.marker === "chat_history") {
      // Insert new-chat separator if configured
      const newChatPrompt = promptBehavior.newChatPrompt;
      if (newChatPrompt) {
        const resolved = (await evaluate(newChatPrompt, macroEnv, registry)).text;
        if (resolved) {
          result.push({ role: "system", content: resolved });
          breakdown.push({ type: "separator", name: "New Chat Prompt", role: "system", content: resolved });
        }
      }

      firstChatIdx = result.length;

      // Insert all chat messages — evaluate macros in each message's content
      // For regenerate: skip the target message (it has a blank swipe)
      let historyCount = 0;
      for (const msg of messages) {
        if (ctx.excludeMessageId && msg.id === ctx.excludeMessageId) continue;
        const role: "user" | "assistant" = msg.is_user ? "user" : "assistant";
        const resolvedContent = (await evaluate(msg.content, macroEnv, registry)).text;
        result.push({ role, content: resolvedContent });
        historyCount++;
      }
      breakdown.push({ type: "chat_history", name: "Chat History", messageCount: historyCount });
      chatHistoryInserted = true;

      // Strip reasoning from older chat history messages based on keepInHistory
      if (reasoningVal) {
        stripReasoningFromChatHistory(result, firstChatIdx, historyCount, reasoningVal);
      }
      continue;
    }

    if (block.marker === "world_info_before") {
      hasWiBefore = true;
      if (wiCache.before.length > 0) {
        for (const entry of wiCache.before) {
          const role = (block.role as LlmMessage["role"]) || entry.role;
          result.push({ role, content: entry.content });
          breakdown.push({ type: "world_info", name: "World Info Before", role, content: entry.content });
        }
      }
      continue;
    }

    if (block.marker === "world_info_after") {
      hasWiAfter = true;
      if (wiCache.after.length > 0) {
        for (const entry of wiCache.after) {
          const role = (block.role as LlmMessage["role"]) || entry.role;
          result.push({ role, content: entry.content });
          breakdown.push({ type: "world_info", name: "World Info After", role, content: entry.content });
        }
      }
      continue;
    }

    // Structural markers → resolve via macro
    if (block.marker && STRUCTURAL_MARKERS.has(block.marker) && MARKER_TO_MACRO[block.marker]) {
      const macro = MARKER_TO_MACRO[block.marker];
      const resolved = (await evaluate(macro, macroEnv, registry)).text.trim();
      if (resolved) {
        const role = (block.role || "system") as LlmMessage["role"];
        result.push({ role, content: resolved });
        breakdown.push({
          type: "block", name: block.name, role: block.role,
          content: resolved, blockId: block.id, marker: block.marker,
        });
      }
      continue;
    }

    // Content-bearing markers and regular blocks → resolve block.content
    const content = block.content || "";
    const resolved = (await evaluate(content, macroEnv, registry)).text.trim();
    if (resolved) {
      // Append roles: collect for deferred application after full assembly
      if (isAppendRole(block.role)) {
        pendingAppends.push({
          baseRole: appendBaseRole(block.role),
          depth: block.depth || 0,
          content: resolved,
          blockName: block.name,
          blockId: block.id,
        });
        continue;
      }
      const role: LlmMessage["role"] = block.position === "post_history" ? "assistant" : (block.role as LlmMessage["role"] || "system");
      result.push({ role, content: resolved });
      breakdown.push({
        type: "block", name: block.name, role,
        content: resolved, blockId: block.id, marker: block.marker ?? undefined,
      });
    }
  }

  // ---- WI auto-injection (if no explicit marker blocks) ----
  //
  // WI position semantics:
  //   0 = "before" → just before chat history
  //   1 = "after"  → just after chat history
  //   2 = AN before, 3 = AN after → around first chat message
  //   4 = depth-based → N messages from the end
  //   5 = EM before, 6 = EM after → around first chat message (example messages area)
  //
  // firstChatIdx = index of the first chat message in `result[]`.
  // We need to compute lastChatIdx = index AFTER the last chat message.

  // Count how many chat messages were inserted (from chat_history block)
  const chatMsgCount = messages.filter((m) =>
    !(ctx.excludeMessageId && m.id === ctx.excludeMessageId)
  ).length;
  const lastChatIdx = firstChatIdx >= 0 ? firstChatIdx + chatMsgCount : result.length;

  // Position 0: "before" — insert just before chat history
  if (!hasWiBefore && wiCache.before.length > 0) {
    const insertAt = firstChatIdx >= 0 ? firstChatIdx : 0;
    const inserted = injectWorldInfoAt(result, breakdown, wiCache.before, insertAt, "World Info Before (auto)");
    // Shift all subsequent anchors since we inserted before the chat block
    if (firstChatIdx >= 0) firstChatIdx += inserted;
  }

  // Position 1: "after" — insert just after chat history
  if (!hasWiAfter && wiCache.after.length > 0) {
    const insertAt = firstChatIdx >= 0 ? firstChatIdx + chatMsgCount : result.length;
    injectWorldInfoAt(result, breakdown, wiCache.after, Math.min(insertAt, result.length), "World Info After (auto)");
  }

  // Positions 2-3 (AN before/after): inject around the start of chat history
  if (wiCache.anBefore.length > 0 && firstChatIdx >= 0) {
    const inserted = injectWorldInfoAt(result, breakdown, wiCache.anBefore, firstChatIdx, "WI AN Before");
    firstChatIdx += inserted;
  }
  if (wiCache.anAfter.length > 0 && firstChatIdx >= 0) {
    const insertAt = firstChatIdx + 1;
    injectWorldInfoAt(result, breakdown, wiCache.anAfter, Math.min(insertAt, result.length), "WI AN After");
  }

  // Positions 5-6 (EM before/after): inject around the start of chat history
  if (wiCache.emBefore.length > 0 && firstChatIdx >= 0) {
    injectWorldInfoAt(result, breakdown, wiCache.emBefore, firstChatIdx, "WI EM Before");
  }
  if (wiCache.emAfter.length > 0 && firstChatIdx >= 0) {
    const insertAt = firstChatIdx + 1;
    injectWorldInfoAt(result, breakdown, wiCache.emAfter, Math.min(insertAt, result.length), "WI EM After");
  }

  // Position 4 (depth-based): insert at result.length - depth
  for (const depthEntry of wiCache.depth) {
    const insertAt = Math.max(0, result.length - depthEntry.depth);
    const role = depthEntry.role as LlmMessage["role"];
    result.splice(insertAt, 0, { role, content: depthEntry.content });
    breakdown.push({ type: "world_info", name: `WI Depth ${depthEntry.depth}`, role: depthEntry.role, content: depthEntry.content });
  }

  // ---- Author's Note injection ----
  const authorsNote: AuthorsNote | null = chat.metadata?.authors_note ?? null;
  if (authorsNote && authorsNote.content) {
    const resolvedAN = (await evaluate(authorsNote.content, macroEnv, registry)).text;
    if (resolvedAN) {
      const insertAt = Math.max(0, result.length - (authorsNote.depth || 4));
      result.splice(insertAt, 0, { role: authorsNote.role || "system", content: resolvedAN });
      breakdown.push({ type: "authors_note", name: "Author's Note", role: authorsNote.role, content: resolvedAN });
    }
  }

  // ---- Utility prompt injection ----

  // Guided generations (from batch-loaded settings)
  const guided = normalizeGuidedGenerations(settingsMap.get("guidedGenerations"));
  if (guided.length > 0) {
    await applyGuidedGenerations(result, guided, macroEnv, breakdown);
  }

  // Continue type: append continueNudge (unless continuePrefill is on)
  if (ctx.generationType === "continue" && !completionSettings.continuePrefill) {
    const nudge = promptBehavior.continueNudge;
    if (nudge) {
      const resolved = (await evaluate(nudge, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "system", content: resolved });
        breakdown.push({ type: "utility", name: "Continue Nudge", role: "system", content: resolved });
      }
    }
  }

  // Continue type: apply continuePostfix to last assistant message
  if (ctx.generationType === "continue" && completionSettings.continuePostfix) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === "assistant") {
        result[i] = { ...result[i], content: result[i].content + completionSettings.continuePostfix };
        break;
      }
    }
  }

  // Impersonate type: append impersonation prompt
  if (ctx.generationType === "impersonate") {
    const prompt = promptBehavior.impersonationPrompt;
    if (prompt) {
      const resolved = (await evaluate(prompt, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "system", content: resolved });
        breakdown.push({ type: "utility", name: "Impersonation Prompt", role: "system", content: resolved });
      }
    }
  }

  // sendIfEmpty: if last message in result is assistant role and content is blank-ish
  if (promptBehavior.sendIfEmpty && result.length > 0) {
    const last = result[result.length - 1];
    if (last.role === "assistant" && !last.content.trim()) {
      const resolved = (await evaluate(promptBehavior.sendIfEmpty, macroEnv, registry)).text;
      if (resolved) {
        result.push({ role: "user", content: resolved });
        breakdown.push({ type: "utility", name: "Send If Empty", role: "user", content: resolved });
      }
    }
  }

  // ---- Build user nudge (replaces assistant prefill for universal compatibility) ----
  // Instead of appending an assistant prefill (which some models reject),
  // we always inject a silent user nudge so the conversation ends with a user message.
  const nudgeParts: string[] = [];

  // Group chat nudge from preset (e.g. "[Write next reply only as {{char}}]")
  if (ctx.targetCharacterId) {
    const groupNudge = promptBehavior.groupNudge;
    if (groupNudge) {
      const resolved = (await evaluate(groupNudge, macroEnv, registry)).text;
      if (resolved) nudgeParts.push(resolved);
    }
  }

  // promptBias (Start Reply With) — folded into the nudge as guidance
  const promptBiasVal = settingsMap.get("promptBias");
  if (promptBiasVal && typeof promptBiasVal === "string" && promptBiasVal.trim()) {
    const resolvedBias = (await evaluate(promptBiasVal, macroEnv, registry)).text;
    if (resolvedBias) nudgeParts.push(`Begin your reply with: ${resolvedBias}`);
  }

  // assistantPrefill / assistantImpersonation — folded into the nudge as guidance
  const csPrefill = (ctx.generationType === "impersonate" && completionSettings.assistantImpersonation)
    ? completionSettings.assistantImpersonation
    : completionSettings.assistantPrefill;
  if (csPrefill) {
    const resolvedPrefill = (await evaluate(csPrefill, macroEnv, registry)).text;
    if (resolvedPrefill) nudgeParts.push(`Begin your reply with: ${resolvedPrefill}`);
  }

  // Ensure the conversation always ends with a user message
  if (nudgeParts.length > 0) {
    const nudgeContent = nudgeParts.join("\n");
    result.push({ role: "user", content: nudgeContent });
    breakdown.push({ type: "utility", name: "User Nudge", role: "user", content: nudgeContent });
  } else if (ctx.generationType === "continue" && result.length > 0 && result[result.length - 1].role === "assistant") {
    // Continue generation with no explicit nudge — add a minimal nudge so the
    // conversation ends on a user message (required by most providers).
    result.push({ role: "user", content: "[Continue]" });
    breakdown.push({ type: "utility", name: "User Nudge", role: "user", content: "[Continue]" });
  }

  // ---- Apply CompletionSettings post-processing (excluding prefill, handled above) ----
  applyCompletionSettings(result, completionSettings, character, persona, ctx.generationType);

  // ---- Apply pending append blocks ----
  for (const append of pendingAppends) {
    applyAppendBlock(result, breakdown, append);
  }

  // ---- Build parameters from sampler overrides + advanced settings + custom body ----
  const parameters = buildParameters(samplerOverrides, preset);

  return {
    messages: result,
    breakdown,
    parameters,
    activatedWorldInfo: activatedWorldInfo.length > 0 ? activatedWorldInfo : undefined,
    deferredWiState,
    deliberationHandledByMacro: !!(macroEnv.extra as any)._deliberationMacroUsed,
  };
}

function normalizeGuidedGenerations(input: unknown): GuidedGeneration[] {
  if (!Array.isArray(input)) return [];
  const out: GuidedGeneration[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const g = item as Partial<GuidedGeneration>;
    if (!g.enabled) continue;
    if (typeof g.content !== "string" || !g.content.trim()) continue;
    const position = g.position === "user_prefix" || g.position === "user_suffix" ? g.position : "system";
    out.push({
      id: typeof g.id === "string" ? g.id : "",
      name: typeof g.name === "string" && g.name.trim() ? g.name : "Guided Generation",
      content: g.content,
      position,
      mode: g.mode === "oneshot" ? "oneshot" : "persistent",
      enabled: true,
    });
  }
  return out;
}

async function applyGuidedGenerations(
  result: LlmMessage[],
  guides: GuidedGeneration[],
  macroEnv: MacroEnv,
  breakdown: AssemblyBreakdownEntry[],
): Promise<void> {
  const systemInjections: string[] = [];
  const prefixes: string[] = [];
  const suffixes: string[] = [];

  for (const guide of guides) {
    const resolved = (await evaluate(guide.content, macroEnv, registry)).text.trim();
    if (!resolved) continue;
    if (guide.position === "system") systemInjections.push(resolved);
    if (guide.position === "user_prefix") prefixes.push(resolved);
    if (guide.position === "user_suffix") suffixes.push(resolved);
  }

  if (systemInjections.length > 0) {
    const insertIdx = result.findIndex((m) => m.role !== "system");
    result.splice(insertIdx >= 0 ? insertIdx : result.length, 0, {
      role: "system",
      content: systemInjections.join("\n\n"),
    });
    breakdown.push({ type: "utility", name: "Guided Generations (system)", role: "system", content: systemInjections.join("\n\n") });
  }

  if (prefixes.length > 0 || suffixes.length > 0) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role !== "user") continue;
      const prefix = prefixes.length > 0 ? `${prefixes.join("\n")}\n` : "";
      const suffix = suffixes.length > 0 ? `\n${suffixes.join("\n")}` : "";
      result[i] = { ...result[i], content: `${prefix}${result[i].content}${suffix}` };
      breakdown.push({ type: "utility", name: "Guided Generations (user)", role: "user" });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Lumia / Loom context loader
// ---------------------------------------------------------------------------

/**
 * Load all Lumia, Loom, Council, OOC, and Sovereign Hand settings and inject
 * them into macroEnv.extra so the lumia/loom macro definitions can read them.
 *
 * When `settingsMap` is provided (from batch load), settings are read from it
 * instead of individual DB queries.
 */
function populateLumiaLoomContext(
  macroEnv: MacroEnv,
  userId: string,
  chat: Chat,
  ctx?: AssemblyContext,
  settingsMap?: Map<string, any>,
): void {
  // Helper to read from batch map or fall back to individual query
  const s = (key: string, fallback: any = null) => {
    if (settingsMap) return settingsMap.get(key) ?? fallback;
    return settingsSvc.getSetting(userId, key)?.value ?? fallback;
  };

  // ---- Lumia selections (persisted by frontend as full LumiaItem objects) ----
  const selectedDef = s("selectedDefinition");
  const selectedBehaviors = s("selectedBehaviors", []);
  const selectedPersonalities = s("selectedPersonalities", []);
  const chimeraMode = s("chimeraMode", false);

  // ---- Quirks ----
  const lumiaQuirks = s("lumiaQuirks", "");
  const lumiaQuirksEnabled = s("lumiaQuirksEnabled", true);

  // ---- OOC ----
  const oocEnabled = s("oocEnabled", true);
  const lumiaOOCInterval = s("lumiaOOCInterval");
  const lumiaOOCStyle = s("lumiaOOCStyle", "social");

  // ---- Sovereign Hand ----
  const sovereignHand = s("sovereignHand", {
    enabled: false,
    excludeLastMessage: true,
    includeMessageInPrompt: true,
  });

  // ---- Council ----
  const councilSettings = getCouncilSettings(userId);

  // Batch-load full Lumia items for council members (single query)
  const memberItemIds = councilSettings.members.map((m: any) => m.itemId);
  const memberItemsMap = memberItemIds.length > 0
    ? packsSvc.getLumiaItemsByIds(userId, memberItemIds)
    : new Map<string, any>();
  const memberItems: Record<string, any> = {};
  for (const [id, item] of memberItemsMap) {
    memberItems[id] = item;
  }

  // ---- Loom selections (may not exist yet — future frontend feature) ----
  const selectedLoomStyles = s("selectedLoomStyles", []);
  const selectedLoomUtils = s("selectedLoomUtils", []);
  const selectedLoomRetrofits = s("selectedLoomRetrofits", []);

  // ---- Loom summary from chat metadata ----
  const loomSummary = (chat.metadata?.loom_summary as string) ?? "";

  // ---- Lazy-load all Lumia items (only fetched if {{randomLumia}} is evaluated) ----
  let _allLumiaItems: any[] | null = null;
  const allItemsLoader = () => {
    if (_allLumiaItems === null) _allLumiaItems = packsSvc.getAllLumiaItems(userId);
    return _allLumiaItems;
  };

  // ---- Inject into env.extra ----
  macroEnv.extra.lumia = {
    selectedDefinition: selectedDef,
    selectedBehaviors,
    selectedPersonalities,
    chimeraMode,
    quirks: lumiaQuirks,
    quirksEnabled: lumiaQuirksEnabled,
    get allItems() { return allItemsLoader(); },
  };

  macroEnv.extra.loom = {
    selectedStyles: selectedLoomStyles,
    selectedUtils: selectedLoomUtils,
    selectedRetrofits: selectedLoomRetrofits,
    summary: loomSummary,
  };

  macroEnv.extra.council = {
    councilMode: councilSettings.councilMode,
    members: councilSettings.members,
    toolsSettings: councilSettings.toolsSettings,
    memberItems,
    // Council tool results — injected from AssemblyContext if available
    toolResults: ctx?.councilToolResults ?? [],
    namedResults: ctx?.councilNamedResults ?? {},
  };

  macroEnv.extra.ooc = {
    enabled: oocEnabled,
    interval: lumiaOOCInterval,
    style: lumiaOOCStyle,
  };

  macroEnv.extra.sovereignHand = sovereignHand;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all WorldBookEntry[] from character extensions + persona attached book.
 */
function collectWorldInfoEntries(userId: string, character: Character, persona: Persona | null, globalWorldBookIds?: string[]): import("../types/world-book").WorldBookEntry[] {
  return collectWorldInfoSources(userId, character, persona, globalWorldBookIds).entries;
}

function collectWorldInfoSources(
  userId: string,
  character: Character,
  persona: Persona | null,
  globalWorldBookIds?: string[],
): { entries: import("../types/world-book").WorldBookEntry[]; worldBookIds: string[] } {
  const entries: import("../types/world-book").WorldBookEntry[] = [];
  const worldBookIds: string[] = [];

  // Character's attached world book (stored in extensions)
  const charBookId = character.extensions?.world_book_id as string | undefined;
  if (charBookId) {
    worldBookIds.push(charBookId);
    entries.push(...worldBooksSvc.listEntries(userId, charBookId));
  }

  // Persona's attached world book
  if (persona?.attached_world_book_id) {
    worldBookIds.push(persona.attached_world_book_id);
    entries.push(...worldBooksSvc.listEntries(userId, persona.attached_world_book_id));
  }

  // Global world books (user-wide, always active regardless of character/persona)
  if (globalWorldBookIds?.length) {
    const seen = new Set(worldBookIds);
    for (const gId of globalWorldBookIds) {
      if (seen.has(gId)) continue; // avoid duplicating a book already attached via character/persona
      seen.add(gId);
      worldBookIds.push(gId);
      entries.push(...worldBooksSvc.listEntries(userId, gId));
    }
  }

  return {
    entries,
    worldBookIds: Array.from(new Set(worldBookIds)),
  };
}

interface VectorActivatedEntry {
  entry: import("../types/world-book").WorldBookEntry;
  score: number;
}

async function collectVectorActivatedWorldInfo(
  userId: string,
  worldBookIds: string[],
  entries: import("../types/world-book").WorldBookEntry[],
  messages: Message[],
): Promise<VectorActivatedEntry[]> {
  if (worldBookIds.length === 0) return [];

  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_world_books) return [];

  const contextSize = Math.max(1, cfg.preferred_context_size || 6);
  const queryText = messages.slice(-contextSize).map((m) => m.content).join("\n").trim();
  if (!queryText) return [];

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out: VectorActivatedEntry[] = [];
  const scored: Array<{ entry: import("../types/world-book").WorldBookEntry; score: number }> = [];
  const seen = new Set<string>();
  const topK = Math.max(1, cfg.retrieval_top_k || 4);

  for (const worldBookId of worldBookIds) {
    try {
      const results = await embeddingsSvc.searchWorldBookEntries(userId, worldBookId, queryText, topK);
      for (const result of results) {
        const entry = byId.get(result.entry_id);
        if (!entry) continue;
        if (seen.has(entry.id)) continue;
        if (entry.disabled || !entry.content.trim()) continue;
        scored.push({ entry, score: result.score });
        seen.add(entry.id);
      }
    } catch (err) {
      console.warn(`[WI] Vector search failed for book ${worldBookId}:`, err);
    }
  }

  // Filter by similarity threshold (LanceDB distance: lower = more similar).
  // Threshold of 0 means no filtering.
  if (cfg.similarity_threshold > 0) {
    const cutoff = cfg.similarity_threshold;
    scored.splice(0, scored.length, ...scored.filter((s) => s.score <= cutoff));
  }

  scored.sort((a, b) => a.score - b.score);

  let cap = topK;
  if (cfg.hybrid_weight_mode === "keyword_first") {
    cap = Math.max(1, Math.ceil(topK / 2));
  } else if (cfg.hybrid_weight_mode === "vector_first") {
    cap = Math.min(24, topK * 2);
  }

  for (const item of scored.slice(0, cap)) {
    out.push({ entry: item.entry, score: item.score });
  }

  return out;
}

function injectEntryIntoCache(cache: WorldInfoCache, entry: import("../types/world-book").WorldBookEntry): void {
  const content = entry.content;
  if (!content) return;
  const role: "system" | "user" | "assistant" =
    entry.role === "user" || entry.role === "assistant" ? entry.role : "system";

  switch (entry.position) {
    case 0:
      cache.before.push({ content, role });
      break;
    case 1:
      cache.after.push({ content, role });
      break;
    case 2:
      cache.anBefore.push({ content, role });
      break;
    case 3:
      cache.anAfter.push({ content, role });
      break;
    case 4:
      cache.depth.push({ content, role, depth: entry.depth });
      break;
    case 5:
      cache.emBefore.push({ content, role });
      break;
    case 6:
      cache.emAfter.push({ content, role });
      break;
    default:
      cache.before.push({ content, role });
      break;
  }
}

function injectWorldInfoAt(
  result: LlmMessage[],
  breakdown: AssemblyBreakdownEntry[],
  entries: Array<{ content: string; role: "system" | "user" | "assistant" }>,
  insertAt: number,
  name: string,
): number {
  if (entries.length === 0) return 0;
  let idx = Math.max(0, Math.min(insertAt, result.length));
  for (const entry of entries) {
    result.splice(idx, 0, { role: entry.role, content: entry.content });
    breakdown.push({ type: "world_info", name, role: entry.role, content: entry.content });
    idx++;
  }
  return entries.length;
}

function applyAppendBlock(
  result: LlmMessage[],
  breakdown: AssemblyBreakdownEntry[],
  append: PendingAppend,
): void {
  let roleCount = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === append.baseRole) {
      if (roleCount === append.depth) {
        result[i] = { ...result[i], content: result[i].content + "\n" + append.content };
        breakdown.push({
          type: "append",
          name: `${append.blockName} → ${append.baseRole}@${append.depth}`,
          role: append.baseRole,
          content: append.content,
          blockId: append.blockId,
        });
        return;
      }
      roleCount++;
    }
  }
  // Target not found — skip silently
}

/**
 * Strip reasoning tags (and surrounding whitespace) from older assistant messages
 * in the chat history range based on reasoningSettings.keepInHistory.
 *
 *   keepInHistory = -1  → keep all (no-op)
 *   keepInHistory =  0  → strip reasoning from every message
 *   keepInHistory =  N  → keep only the N most recent reasoning blocks
 */
function stripReasoningFromChatHistory(
  result: LlmMessage[],
  firstChatIdx: number,
  historyCount: number,
  reasoningSettings: { prefix?: string; suffix?: string; keepInHistory?: number },
): void {
  const keepInHistory = reasoningSettings.keepInHistory ?? -1;
  if (keepInHistory === -1) return;

  const rawPrefix = (reasoningSettings.prefix ?? "<think>\n").replace(/^\n+|\n+$/g, "");
  const rawSuffix = (reasoningSettings.suffix ?? "\n</think>").replace(/^\n+|\n+$/g, "");

  const escapedPrefix = rawPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSuffix = rawSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\s*${escapedPrefix}[\\s\\S]*?${escapedSuffix}\\s*`, "g");

  const endIdx = firstChatIdx + historyCount;
  let reasoningBlocksSeen = 0;

  for (let i = endIdx - 1; i >= firstChatIdx; i--) {
    if (result[i].role !== "assistant") continue;

    const stripped = result[i].content.replace(pattern, "").trim();
    if (stripped === result[i].content.trim()) continue; // No reasoning found

    reasoningBlocksSeen++;
    if (reasoningBlocksSeen > keepInHistory) {
      result[i] = { ...result[i], content: stripped };
    }
  }
}

/**
 * Apply CompletionSettings as a post-processing pass on the assembled messages.
 * Handles squashSystemMessages, useSystemPrompt, namesBehavior, and assistantPrefill
 * in a single O(n) pass (where possible).
 */
function applyCompletionSettings(
  result: LlmMessage[],
  settings: CompletionSettings,
  character: Character,
  persona: Persona | null,
  generationType: GenerationType,
): void {
  // Single forward pass: squash consecutive system messages + convert system→user
  // + apply namesBehavior
  const squash = settings.squashSystemMessages;
  const noSystem = settings.useSystemPrompt === false;
  const namesBehavior = settings.namesBehavior ?? 0;

  let i = 0;
  while (i < result.length) {
    const msg = result[i];

    // Squash: merge consecutive system messages
    if (squash && msg.role === "system" && i > 0 && result[i - 1].role === "system") {
      result[i - 1] = { ...result[i - 1], content: result[i - 1].content + "\n\n" + msg.content };
      result.splice(i, 1);
      continue; // re-check same index
    }

    // useSystemPrompt false: convert system → user
    if (noSystem && msg.role === "system") {
      result[i] = { ...msg, role: "user" };
    }

    // namesBehavior: 1 = add name field, 2 = prepend "Name: " to content
    if (namesBehavior === 1 && (msg.role === "user" || msg.role === "assistant")) {
      const name = msg.role === "user" ? (persona?.name ?? "User") : character.name;
      result[i] = { ...result[i], name };
    } else if (namesBehavior === 2 && (msg.role === "user" || msg.role === "assistant")) {
      const name = msg.role === "user" ? (persona?.name ?? "User") : character.name;
      result[i] = { ...result[i], content: `${name}: ${result[i].content}` };
    }

    i++;
  }

  // NOTE: assistantPrefill is now folded into the user nudge by assemblePrompt().
}

/**
 * Map SamplerOverrides + advanced settings + customBody to API-compatible parameter object.
 */
function buildParameters(overrides: SamplerOverrides | null, preset: Preset | null): Record<string, any> {
  const params: Record<string, any> = {};

  // Sampler overrides
  if (overrides?.enabled) {
    for (const [camelKey, apiKey] of Object.entries(SAMPLER_KEY_MAP)) {
      const val = (overrides as any)[camelKey];
      if (val !== null && val !== undefined) {
        params[apiKey] = val;
      }
    }
  }

  // Advanced settings from preset.prompts.advancedSettings
  const advancedSettings = preset?.prompts?.advancedSettings;
  if (advancedSettings) {
    if (Array.isArray(advancedSettings.customStopStrings) && advancedSettings.customStopStrings.length > 0) {
      params.stop = advancedSettings.customStopStrings;
    }
    if (typeof advancedSettings.seed === "number" && advancedSettings.seed >= 0) {
      params.seed = advancedSettings.seed;
    }
  }

  // Custom body from preset.parameters.customBody
  const customBody = preset?.parameters?.customBody;
  if (customBody?.enabled && customBody.rawJson) {
    try {
      const custom = JSON.parse(customBody.rawJson);
      Object.assign(params, custom);
    } catch {
      // Invalid JSON — skip silently
    }
  }

  return params;
}

/**
 * Legacy assembly: simple message mapping with no preset.
 * Includes character card as system prompt for usable generation.
 */
async function legacyAssembly(
  messages: Message[],
  generationType: GenerationType,
  character?: Character | null,
  persona?: Persona | null,
  chat?: Chat | null,
  connection?: ConnectionProfile | null,
  userId?: string,
): Promise<AssemblyResult> {
  const llmMessages: LlmMessage[] = [];
  const breakdown: AssemblyBreakdownEntry[] = [];

  // Initialize macros for legacy path too
  initMacros();
  let macroEnv: MacroEnv | null = null;
  if (character && chat) {
    macroEnv = buildEnv({
      character: character as Character,
      persona: persona ?? null,
      chat: chat as Chat,
      messages,
      generationType,
      connection: connection ?? null,
    });
    // Populate reasoning macros
    if (userId) {
      const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
      if (reasoningSetting?.value) {
        macroEnv.extra.reasoningPrefix = reasoningSetting.value.prefix ?? "";
        macroEnv.extra.reasoningSuffix = reasoningSetting.value.suffix ?? "";
      }
      // Populate Lumia / Loom context (legacy path)
      if (chat) populateLumiaLoomContext(macroEnv, userId, chat as Chat);
    }
  }

  const resolveMacros = async (text: string): Promise<string> => {
    if (macroEnv) return (await evaluate(text, macroEnv, registry)).text;
    return text;
  };

  // Build a system prompt from the character card
  const systemParts: string[] = [];
  if (character?.description) systemParts.push(character.description);
  if (character?.personality) systemParts.push(`Personality: ${character.personality}`);
  if (character?.scenario) systemParts.push(`Scenario: ${character.scenario}`);
  if (persona?.description) systemParts.push(`[User persona: ${persona.description}]`);

  if (systemParts.length > 0) {
    const systemContent = await resolveMacros(systemParts.join("\n\n"));
    llmMessages.push({ role: "system", content: systemContent });
    breakdown.push({ type: "block", name: "Character Card (legacy)", role: "system", content: systemContent });
  }

  // Add dialogue examples if present
  if (character?.mes_example) {
    const examples = character.mes_example.trim();
    if (examples) {
      const resolvedExamples = await resolveMacros(`Example dialogue:\n${examples}`);
      llmMessages.push({ role: "system", content: resolvedExamples });
      breakdown.push({ type: "block", name: "Dialogue Examples (legacy)", role: "system", content: resolvedExamples });
    }
  }

  // Chat history — evaluate macros in each message
  const legacyFirstChatIdx = llmMessages.length;
  let legacyHistoryCount = 0;
  for (const m of messages) {
    llmMessages.push({
      role: (m.is_user ? "user" : "assistant") as LlmMessage["role"],
      content: await resolveMacros(m.content),
    });
    legacyHistoryCount++;
  }
  breakdown.push({ type: "chat_history", name: "Chat History (legacy)", messageCount: legacyHistoryCount });

  // Strip reasoning from older chat history messages based on keepInHistory
  if (userId) {
    const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
    if (reasoningSetting?.value) {
      stripReasoningFromChatHistory(llmMessages, legacyFirstChatIdx, legacyHistoryCount, reasoningSetting.value);
    }
  }

  return { messages: llmMessages, breakdown, parameters: {} };
}
