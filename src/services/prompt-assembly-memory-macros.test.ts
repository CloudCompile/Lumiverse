import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { initMacros } from "../macros";
import type { PromptBlock } from "../types/preset";
import { abortChatBackground } from "./chat-background.service";
import { createCharacter } from "./characters.service";
import { createChat, createMessage } from "./chats.service";
import { createDatabank } from "./databank";
import { clearAllDatabankCache, setCachedDatabankResult } from "./databank/retrieval-cache.service";
import { clearCortexResultCaches, primeCortexCache, primeLinkedCortexCache, type CortexResult } from "./memory-cortex";
import { recordColorAttribution } from "./memory-cortex/font-attribution";
import { createPreset } from "./presets.service";
import { assemblePrompt } from "./prompt-assembly.service";
import { putSetting } from "./settings.service";

const userId = "memory-macro-user";
const liveContent = "LIVE_USER_MESSAGE";
const workerState = globalThis as { __LUMIVERSE_ASSEMBLY_WORKER?: boolean };
let originalWorkerState: boolean | undefined;
let character: ReturnType<typeof createCharacter>;
let chat: ReturnType<typeof createChat>;
let message: ReturnType<typeof createMessage>;

function block(content: string, overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: crypto.randomUUID(),
    name: "Context",
    enabled: true,
    role: "system",
    marker: null,
    content,
    position: "pre_history",
    depth: 0,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...overrides,
  };
}

function cortexResult(overrides: Partial<CortexResult> = {}): CortexResult {
  return {
    memories: [{
      source: "chunk",
      sourceId: "memory-1",
      content: "CORTEX_MEMORY",
      finalScore: 0.9,
      components: { semantic: 0.9, salience: 0.9, recency: 0.9, reinforcement: 0, emotional: 0, entity: 0 },
      emotionalTags: [],
      entityNames: ["Kael"],
      messageRange: [0, 0],
      timeRange: [0, 0],
    }],
    entityContext: [{
      id: "entity-1",
      name: "Kael",
      type: "character",
      status: "active",
      description: "A traveler",
      lastSeenAt: null,
      mentionCount: 1,
      topFacts: ["ENTITY_FACT"],
      emotionalProfile: {},
      relationships: [],
    }],
    activeRelationships: [{
      sourceName: "Kael",
      targetName: "Mira",
      type: "ally",
      label: "RELATIONSHIP_LABEL",
      strength: 0.8,
      sentiment: 0.8,
    }],
    arcContext: "ARC_CONTEXT",
    stats: {
      candidatePoolSize: 1,
      vectorSearchResults: 1,
      entitiesMatched: 1,
      scoreFusionApplied: true,
      topScore: 0.9,
      retrievalTimeMs: 0,
    },
    ...overrides,
  };
}

function enableCortex(result = cortexResult(), useChatMemoryFormatting = false): void {
  putSetting(userId, "memoryCortexConfig", { enabled: true, formatterMode: "shadow", useChatMemoryFormatting });
  primeCortexCache(chat.id, result, [message.id]);
}

function enableDatabank(): void {
  putSetting(userId, "embeddingConfig", { enabled: true });
  const bank = createDatabank(userId, { name: "References", scope: "global" });
  setCachedDatabankResult(userId, chat.id, [bank.id], liveContent, 4, {
    chunks: [{
      chunkId: "chunk-1",
      documentId: "document-1",
      databankId: bank.id,
      documentName: "Reference",
      content: "DATABANK_CONTENT",
      score: 1,
      metadata: {},
    }],
    formatted: "[Relevant reference material]\n[Source: Reference]\nDATABANK_CONTENT",
    count: 1,
  });
}

function enableCharacterColors(): void {
  getDb().query(
    "INSERT INTO memory_entities (id, chat_id, name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
  ).run("entity-1", chat.id, "Kael");
  recordColorAttribution(chat.id, "#abcdef", "entity-1", "speech", null);
  recordColorAttribution(chat.id, "#abcdef", "entity-1", "speech", null);
}

async function assemble(blocks: PromptBlock[] = []) {
  const preset = createPreset(userId, {
    name: "Macro placement",
    provider: "openai",
    prompt_order: [...blocks, block("", { name: "History", marker: "chat_history" })],
  });
  return assemblePrompt({
    userId,
    chatId: chat.id,
    presetOverride: preset,
    generationType: "normal",
    skipPromptRegex: true,
    macroCommit: false,
  });
}

beforeEach(async () => {
  const database = initDatabase(":memory:");
  database.run("PRAGMA foreign_keys = OFF");
  database.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  initMacros();
  originalWorkerState = workerState.__LUMIVERSE_ASSEMBLY_WORKER;
  workerState.__LUMIVERSE_ASSEMBLY_WORKER = true;
  character = createCharacter(userId, { name: "Character" });
  chat = createChat(userId, { character_id: character.id });
  message = createMessage(chat.id, { is_user: true, name: "User", content: liveContent }, userId);
});

afterEach(async () => {
  await abortChatBackground(userId, chat.id);
  if (originalWorkerState === undefined) delete workerState.__LUMIVERSE_ASSEMBLY_WORKER;
  else workerState.__LUMIVERSE_ASSEMBLY_WORKER = originalWorkerState;
  clearCortexResultCaches();
  clearAllDatabankCache();
  closeDatabase();
});

describe("memory macro placement", () => {
  test("falls back before history when Cortex macros are absent, including with macro-only chat memory", async () => {
    enableCortex();
    const result = await assemble();
    const memoryIndex = result.messages.findIndex(({ content }) => String(content).includes("ENTITY_FACT"));
    const historyIndex = result.messages.findIndex(({ content }) => content === liveContent);
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeLessThan(historyIndex);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
  });

  test.each([false, true])("injects graph-only Cortex context with chat-memory formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [] }), useChatMemoryFormatting);
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "fallback" });
    const result = await assemble();
    expect(result.messages.map(({ content }) => content).join("\n")).toContain("ENTITY_FACT");
    expect(result.memoryStats?.chunksRetrieved).toBe(0);
    expect(result.breakdown.filter(({ type }) => type === "long_term_memory")).toHaveLength(1);
  });

  test.each([
    ["{{entities}}", "ENTITY_FACT"],
    ["{{entityFacts::Kael}}", "ENTITY_FACT"],
    ["{{relationships}}", "RELATIONSHIP_LABEL"],
    ["{{arc}}", "ARC_CONTEXT"],
    ["{{memorySalience}}", "CORTEX_MEMORY"],
    ["{{ ENTITIES::1 }}", "ENTITY_FACT"],
  ])("Cortex macro %s owns its placement instead of also falling back", async (macro, expected) => {
    enableCortex();
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "fallback" });
    const result = await assemble([block(`BEGIN ${macro} END`)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.split(expected)).toHaveLength(2);
    expect(content).toContain("BEGIN");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
    expect(result.breakdown.filter(({ type, excludeFromTotal }) => type === "long_term_memory" && !excludeFromTotal)).toHaveLength(0);
  });

  test.each([
    "{{memories}}",
    "{{memories::1}}",
    "{{memoriesRaw}}",
    "{{longTermMemory}}",
    "{{chatMemory}}",
    "{{ltm}}",
    "{{ MEMORIES }}",
    "{{#memories}}",
    "{{if {{memoriesActive}} = yes}}{{memories}}{{/if}}",
  ])("memory macro %s owns its placement", async (macro) => {
    enableCortex();
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "fallback" });
    const result = await assemble([block(`BEGIN ${macro} END`)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/CORTEX_MEMORY/g)).toHaveLength(1);
    expect(content).toContain("BEGIN");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
  });

  test.each([
    "{{databank}}",
    "{{databankRaw}}",
    "{{databankRaw::1}}",
    "{{databankMemory}}",
    "{{documents}}",
    "{{knowledgeBank}}",
    "{{ DATABANKRAW }}",
    "{{#databankRaw}}",
    "{{if {{databankActive}} = yes}}{{databankRaw}}{{/if}}",
  ])("databank macro %s owns its placement without a duplicate fallback", async (macro) => {
    enableDatabank();
    const result = await assemble([block(`BEGIN ${macro} END`)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/DATABANK_CONTENT/g)).toHaveLength(1);
    expect(content).toContain("BEGIN");
    expect(result.databankStats?.injectionMethod).toBe("macro");
    expect(result.breakdown.filter(({ type }) => type === "databank")).toHaveLength(0);
  });

  test.each([
    { enabled: false },
    { injectionTrigger: ["regenerate"] },
    { characterTagTrigger: ["other-character"] },
    { marker: "world_info_before" },
  ] satisfies Partial<PromptBlock>[])("ignored blocks do not suppress fallback: %j", async (overrides) => {
    enableCortex();
    enableDatabank();
    const result = await assemble([block("BEGIN {{entities}} {{databankRaw}} END", overrides)]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content).not.toContain("BEGIN");
    expect(content.match(/ENTITY_FACT/g)).toHaveLength(1);
    expect(content.match(/DATABANK_CONTENT/g)).toHaveLength(1);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
    expect(result.databankStats?.injectionMethod).toBe("fallback");
  });

  test.each([
    "{{#escape}}{{entities}} {{databankRaw}}{{/escape}}",
    "{{#comment}}{{entities}} {{databankRaw}}{{/comment}}",
    "{{#note}}{{entities}} {{databankRaw}}{{/note}}",
    "\\{\\{entities\\}\\} \\{\\{databankRaw\\}\\}",
    "{{memoriesUnknown}} {{databankRawUnknown}}",
    "{{cortexActive}} {{entityCount}} {{memoriesActive}} {{memoriesCount}} {{databankActive}} {{databankCount}}",
  ])("non-content references do not suppress fallback: %s", async (content) => {
    enableCortex();
    enableDatabank();
    const result = await assemble([block(content)]);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
    expect(result.databankStats?.injectionMethod).toBe("fallback");
    expect(result.messages.map(({ content }) => content).join("\n")).toContain("DATABANK_CONTENT");
  });

  test.each([false, true])("the memories macro renders graph-only context with formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [] }), useChatMemoryFormatting);
    const result = await assemble([block("BEGIN {{if {{memoriesActive}} = yes}}{{memories}}{{/if}} END")]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/ENTITY_FACT/g)).toHaveLength(1);
    expect(content).toContain("BEGIN");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
  });

  test.each([false, true])("fallback includes character colors without chunk memories with formatting %s", async (useChatMemoryFormatting) => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }), useChatMemoryFormatting);
    enableCharacterColors();
    const result = await assemble();
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/#abcdef/g)).toHaveLength(1);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
  });

  test("characterColors owns its placement", async () => {
    enableCortex();
    enableCharacterColors();
    const result = await assemble([block("BEGIN {{characterColors}} END")]);
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/#abcdef/g)).toHaveLength(1);
    expect(content).not.toContain("ENTITY_FACT");
    expect(result.memoryStats?.injectionMethod).toBe("macro");
  });

  test("fallback includes linked Cortex even without local chunks", async () => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }));
    primeLinkedCortexCache(chat.id, {
      vaults: [{ vaultId: "vault-1", vaultName: "Linked", entities: cortexResult().entityContext, relations: [] }],
      interlinks: [],
    });
    const result = await assemble();
    const content = result.messages.map(({ content }) => content).join("\n");
    expect(content.match(/ENTITY_FACT/g)).toHaveLength(1);
    expect(result.memoryStats?.injectionMethod).toBe("fallback");
  });

  test("explicitly disabled memory injection does not fall back to Cortex", async () => {
    enableCortex();
    putSetting(userId, "chatMemorySettings", { injectionStrategy: "disabled" });
    const result = await assemble();
    expect(result.messages.map(({ content }) => content).join("\n")).not.toContain("ENTITY_FACT");
    expect(result.memoryStats?.injectionMethod).toBe("disabled");
  });

  test("empty retrieval does not inject a blank context message", async () => {
    enableCortex(cortexResult({ memories: [], entityContext: [], activeRelationships: [], arcContext: null }));
    const result = await assemble();
    expect(result.messages.map(({ content }) => content)).toEqual([liveContent]);
  });
});
