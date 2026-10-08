import { evaluate, registry, type MacroEnv } from "../macros";
import { sanitizeForVectorization, type SanitizeOptions } from "../utils/content-sanitizer";

const HAS_MACRO_HINT_RE = /\{\{|<(?:user|char|bot)>/i;

export function contentHasMacroHints(content: string): boolean {
  return HAS_MACRO_HINT_RE.test(content);
}

export async function resolveAndSanitizeForVectorization(
  content: string,
  env: MacroEnv | null,
  options?: SanitizeOptions,
  maskScanContent?: (content: string) => string,
): Promise<string> {
  // World Info excludes source text before it can execute, and masks markup
  // emitted by macros before HTML cleanup removes its exclusion attributes.
  if (maskScanContent) content = maskScanContent(content);
  if (!content) return "";
  let resolved = content;
  if (env && HAS_MACRO_HINT_RE.test(content)) {
    try {
      const result = await evaluate(content, env, registry);
      resolved = result.text;
    } catch {
      resolved = content;
    }
    if (maskScanContent) resolved = maskScanContent(resolved);
  }
  return sanitizeForVectorization(resolved, options);
}
