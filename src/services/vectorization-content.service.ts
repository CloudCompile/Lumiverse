import { evaluate, registry, type MacroEnv } from "../macros";
import { withJsonBlocksProtected } from "../macros/json-blocks";
import { restoreLiteralBraces } from "../macros/literal-braces";
import { sanitizeForVectorization, type SanitizeOptions } from "../utils/content-sanitizer";

const HAS_MACRO_HINT_RE = /\{\{|<(?:user|char|bot)>/i;

export function contentHasMacroHints(content: string): boolean {
  return HAS_MACRO_HINT_RE.test(content);
}

export async function resolveAndSanitizeForVectorization(
  content: string,
  env: MacroEnv | null,
  options?: SanitizeOptions,
): Promise<string> {
  if (!content) return "";
  let resolved = content;
  if (env && HAS_MACRO_HINT_RE.test(content)) {
    try {
      resolved = await withJsonBlocksProtected(content, env, async (protectedContent) =>
        (await evaluate(protectedContent, env, registry)).text,
      );
    } catch {
      resolved = content;
    }
  }
  return sanitizeForVectorization(restoreLiteralBraces(resolved), options);
}
