/**
 * Prompt variables macros — preset-scoped typed inputs configured by end users.
 *
 * Defs live on PromptBlock.variables. Values live in preset.metadata.promptVariables
 * keyed by block id. prompt-assembly.service.ts merges values over defaults,
 * coerces + clamps per type, and writes the results to env.extra.promptVariables
 * before any block content is evaluated.
 *
 * env.extra shape:
 *   promptVariables         — Record<varName, string | number>   flat; last enabled block wins
 *   promptVariablesByBlock  — Record<blockId, Record<varName, string | number>>
 *   promptVariableDefaults  — Record<varName, string | number>   creator-declared defaults
 *
 * Variables on disabled blocks are skipped at resolution time, so {{hasVar::x}}
 * reflects whether a variable is actually in play for this generation.
 */

import { registry } from "../MacroRegistry";
import type { MacroExecContext } from "../types";

function resolveKey(ctx: MacroExecContext): string | null {
  const raw = (ctx.args[0] ?? ctx.body ?? "").trim();
  return raw.length ? raw : null;
}

function getValues(ctx: MacroExecContext): Record<string, string | number> {
  return (ctx.env.extra.promptVariables ?? {}) as Record<string, string | number>;
}

function getDefaults(ctx: MacroExecContext): Record<string, string | number> {
  return (ctx.env.extra.promptVariableDefaults ?? {}) as Record<string, string | number>;
}

export function registerPromptVarMacros(): void {
  // {{var::name}} — configured value, falling back to creator default, then empty string
  registry.registerMacro({
    name: "var",
    category: "state",
    description:
      "Read a preset-scoped prompt variable value. Returns the end-user override, the creator default, or an empty string. Variables on disabled blocks are skipped.",
    args: [{ name: "name", type: "string", description: "Variable name defined on a prompt block" }],
    aliases: ["promptVar", "presetVar"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const key = resolveKey(ctx);
      if (!key) return "";
      const values = getValues(ctx);
      if (key in values) return String(values[key]);
      const defaults = getDefaults(ctx);
      if (key in defaults) return String(defaults[key]);
      return "";
    },
  });

  // {{hasVar::name}} — is this variable resolvable right now?
  registry.registerMacro({
    name: "hasVar",
    category: "state",
    description:
      "Returns 'true' if the named prompt variable is defined on an enabled block, 'false' otherwise.",
    args: [{ name: "name", type: "string", description: "Variable name" }],
    aliases: ["hasPromptVar", "hasPresetVar"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const key = resolveKey(ctx);
      if (!key) return "false";
      const values = getValues(ctx);
      const defaults = getDefaults(ctx);
      return key in values || key in defaults ? "true" : "false";
    },
  });

  // {{varDefault::name}} — creator-declared default, ignoring any end-user override
  registry.registerMacro({
    name: "varDefault",
    category: "state",
    description:
      "Read the creator-declared default for a prompt variable, ignoring any end-user override.",
    args: [{ name: "name", type: "string", description: "Variable name" }],
    aliases: ["promptVarDefault", "presetVarDefault"],
    builtIn: true,
    handler(ctx: MacroExecContext): string {
      const key = resolveKey(ctx);
      if (!key) return "";
      const defaults = getDefaults(ctx);
      return key in defaults ? String(defaults[key]) : "";
    },
  });
}
