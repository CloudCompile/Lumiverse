/**
 * Integration probe: exercises the exact `resolvePromptVariables` path used
 * by prompt-assembly on a fabricated preset + block graph, then evaluates a
 * template that references `{{var::}}`, `{{getvar::}}`, and the dot-prefix
 * shorthand. Reports what each macro resolves to.
 *
 * Usage: bun run tests/preset-var-integration.ts
 */
import { registry } from "../src/macros/MacroRegistry";
import { initMacros } from "../src/macros";
import { evaluate } from "../src/macros/MacroEvaluator";
import type { MacroEnv } from "../src/macros/types";
import type { PromptBlock, PromptVariableDef, PromptVariableValue } from "../src/types/preset";

initMacros();

// Minimal repro of the exact function body from prompt-assembly.service.ts
function resolvePromptVariables(
  env: MacroEnv,
  blocks: PromptBlock[],
  stored: Record<string, Record<string, PromptVariableValue>>,
) {
  const values: Record<string, PromptVariableValue> = {};
  const defaults: Record<string, PromptVariableValue> = {};
  for (const block of blocks) {
    if (!block.enabled || !block.variables?.length) continue;
    const bucket = stored[block.id] ?? {};
    for (const def of block.variables) {
      if (!def?.name) continue;
      const override = Object.prototype.hasOwnProperty.call(bucket, def.name)
        ? bucket[def.name]
        : undefined;
      const resolved = coerce(def, override);
      values[def.name] = resolved;
      defaults[def.name] = coerce(def, undefined);
    }
  }
  (env.extra as any).promptVariables = values;
  (env.extra as any).promptVariableDefaults = defaults;
  for (const [name, value] of Object.entries(values)) {
    if (!env.variables.local.has(name)) env.variables.local.set(name, String(value));
  }
}

function coerce(def: PromptVariableDef, raw: unknown): PromptVariableValue {
  switch (def.type) {
    case "text":
    case "textarea":
      if (raw === undefined || raw === null) return def.defaultValue ?? "";
      return String(raw);
    case "number": {
      const fallback = typeof def.defaultValue === "number" ? def.defaultValue : 0;
      const n = raw === undefined || raw === null ? fallback : Number(raw);
      return Number.isFinite(n) ? n : fallback;
    }
    case "slider": {
      const fallback = typeof def.defaultValue === "number" ? def.defaultValue : (def as any).min;
      const n = raw === undefined || raw === null ? fallback : Number(raw);
      return Number.isFinite(n) ? n : fallback;
    }
  }
}

const blocks: PromptBlock[] = [
  {
    id: "block-length",
    name: "Loom Length",
    content:
      "**Target:** {{var::length_target}} words OR {{var::paragraph_target}} paragraphs.\n" +
      "getvar: {{getvar::length_target}} / {{getvar::paragraph_target}}\n" +
      "dot: {{.length_target}} / {{.paragraph_target}}",
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    variables: [
      { id: "v1", name: "length_target", label: "Words", type: "number", defaultValue: 500 },
      { id: "v2", name: "paragraph_target", label: "Paragraphs", type: "number", defaultValue: 5 },
    ],
  } as any,
];

const env: MacroEnv = {
  names: { user: "", char: "", group: "", groupNotMuted: "", notChar: "", charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", groupLastSpeaker: "" },
  character: { name: "", description: "", personality: "", scenario: "", persona: "", personaSubjectivePronoun: "", personaObjectivePronoun: "", personaPossessivePronoun: "", mesExamples: "", mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "", depthPrompt: "", creatorNotes: "", version: "", creator: "", firstMessage: "" } as any,
  chat: { id: "", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "", lastCharMessage: "", lastMessageId: -1, firstIncludedMessageId: -1, lastSwipeId: 0, currentSwipeId: 0 },
  system: { model: "", maxPrompt: 0, maxContext: 0, maxResponse: 0, lastGenerationType: "normal", isMobile: false },
  variables: { local: new Map(), global: new Map(), chat: new Map() },
  dynamicMacros: {},
  extra: {},
} as any;

// === Case A: no overrides stored — defaults only ===
resolvePromptVariables(env, blocks, {});
console.log("Case A — defaults only:");
console.log((await evaluate(blocks[0].content, env, registry as any)).text);
console.log("env.extra.promptVariables =", (env.extra as any).promptVariables);
console.log();

// === Case B: overrides stored ===
const env2: MacroEnv = JSON.parse(JSON.stringify(env));
env2.variables = { local: new Map(), global: new Map(), chat: new Map() } as any;
env2.extra = {} as any;
resolvePromptVariables(env2, blocks, {
  "block-length": { length_target: 1200, paragraph_target: 12 },
});
console.log("Case B — stored overrides:");
console.log((await evaluate(blocks[0].content, env2, registry as any)).text);
console.log("env.extra.promptVariables =", (env2.extra as any).promptVariables);
console.log();

// === Case C: block has variables but is DISABLED ===
const env3: MacroEnv = { ...env, variables: { local: new Map(), global: new Map(), chat: new Map() }, extra: {} } as any;
const disabledBlocks = blocks.map((b) => ({ ...b, enabled: false }));
resolvePromptVariables(env3, disabledBlocks, { "block-length": { length_target: 1200 } });
console.log("Case C — block disabled:");
console.log((await evaluate(blocks[0].content, env3, registry as any)).text);
console.log("env.extra.promptVariables =", (env3.extra as any).promptVariables);
console.log();

// === Case D: block is enabled but has no `variables` field at all ===
const env4: MacroEnv = { ...env, variables: { local: new Map(), global: new Map(), chat: new Map() }, extra: {} } as any;
const noVarsBlocks = blocks.map((b) => ({ ...b, variables: undefined as any }));
resolvePromptVariables(env4, noVarsBlocks, { "block-length": { length_target: 1200 } });
console.log("Case D — block has no variables schema:");
console.log((await evaluate(noVarsBlocks[0].content, env4, registry as any)).text);
console.log("env.extra.promptVariables =", (env4.extra as any).promptVariables);
