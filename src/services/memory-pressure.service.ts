import { getDb } from "../db/connection";
import { releaseDatabaseMemory } from "../db/maintenance";
import { clearCapabilityCache } from "../image-gen/comfyui-discovery";
import { clearOpenRouterMetadataCache } from "../llm/providers/openrouter";
import { clearMacroAstCache } from "../macros/MacroParser";
import { releaseIdleRegexWorkers } from "../utils/regex-sandbox";
import { releaseIdleCortexWarmWorker } from "./cortex-warm-worker-client";
import { clearAllResolveCache } from "./databank/mention-resolver.service";
import { clearAllDatabankCache } from "./databank/retrieval-cache.service";
import { releaseIdleWebPageParserWorkers } from "./databank/web-page-parser-worker-client";
import { resetDisplayRegexCache } from "./display-regex.service";
import { embeddingCache } from "./embedding-cache";
import { clearCortexResultCaches } from "./memory-cortex";
import { releaseIdleHeuristicWorkers } from "./memory-cortex/heuristic-worker-host";
import { clearStmtCache } from "./pagination";
import { releaseIdlePromptAssemblyWorkers } from "./prompt-assembly-worker-client";
import { releaseSharpCacheMemory } from "./sharp-settings.service";
import { clearVectorWorldInfoCache } from "./prompt-assembly.service";
import { releaseTokenizerMemory } from "./tokenizer.service";
import { clearWorldInfoActivationCache } from "./world-info-activation.service";

export type MemoryPressureLevel = "warning" | "critical";

const releasers: ReadonlyArray<readonly [string, () => unknown]> = [
  ["tokenizers", releaseTokenizerMemory],
  ["embeddings", () => embeddingCache.clearMemory()],
  ["memory cortex", clearCortexResultCaches],
  ["vector world info", clearVectorWorldInfoCache],
  ["world info activation", clearWorldInfoActivationCache],
  ["display regex", resetDisplayRegexCache],
  ["databank retrieval", clearAllDatabankCache],
  ["databank mentions", clearAllResolveCache],
  ["macro ASTs", clearMacroAstCache],
  ["ComfyUI capabilities", clearCapabilityCache],
  ["OpenRouter metadata", clearOpenRouterMetadataCache],
  ["prepared statements", clearStmtCache],
  ["Sharp cache", releaseSharpCacheMemory],
  ["prompt assembly workers", releaseIdlePromptAssemblyWorkers],
  ["cortex heuristic workers", releaseIdleHeuristicWorkers],
  ["regex workers", releaseIdleRegexWorkers],
  ["cortex warm worker", releaseIdleCortexWarmWorker],
  ["web parser workers", releaseIdleWebPageParserWorkers],
];

const criticalReleasers: ReadonlyArray<readonly [string, () => unknown]> = [
  ["SQLite", () => releaseDatabaseMemory(getDb())],
  ["garbage collector", () => Bun.gc(true)],
];

let installed = false;

/** Release only derived state and idle resources; active work is left untouched. */
export function releaseMemoryPressureResources(level: MemoryPressureLevel): string[] {
  const failures: string[] = [];
  const selected = level === "critical" ? [...releasers, ...criticalReleasers] : releasers;
  for (const [name, release] of selected) {
    try {
      release();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function handleMemoryPressure(level: MemoryPressureLevel): void {
  const failures = releaseMemoryPressureResources(level);
  if (failures.length === 0) {
    console.warn(`[runtime] ${level} memory pressure: released reconstructable state and idle resources`);
  } else {
    console.warn(
      `[runtime] ${level} memory pressure: resource release completed with errors: ${failures.join("; ")}`,
    );
  }
}

export function installMemoryPressureHandler(): void {
  if (installed) return;
  installed = true;
  process.on("memoryPressure", handleMemoryPressure);
}
