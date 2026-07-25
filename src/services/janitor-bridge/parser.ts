// ─────────────────────────────────────────────────────────────────────────────
// Janitor AI text-format character card parser
//
// Ported from janitor-proxy-extractor/lib/parser.js (commit d42ae93, with the
// 19 bug fixes through 0353bee). Handles three known Janitor formatting
// variants:
//
//   1. Janitor quote-block format (">**Field:**\n value")
//   2. Bullet format ("- Field: value" / "• Field: value")
//   3. Embedded V2 JSON card (in any message)
//
// Outputs a SillyTavern-compatible V2 character card:
//   { spec: 'chara_card_v2', spec_version: '2.0', data: { ... } }
// ─────────────────────────────────────────────────────────────────────────────

import { autoTagCard } from "./tags";

export interface JanitorMessage {
  role: "system" | "user" | "assistant" | string;
  content: string | any;
  name?: string;
}

export interface V2CardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  creator: string;
  character_version: string;
  alternate_greetings: string[];
  extensions: Record<string, any>;
  [key: string]: any;
}

export interface V2Card {
  spec: "chara_card_v2";
  spec_version: "2.0";
  data: V2CardData;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract persona tag name and body text.
 * Handles: <Name's Persona>>, <Name's Persona>, <Name Persona>>
 * Names can contain spaces, hyphens, apostrophes, periods, AND non-ASCII
 * characters (Júlia, Kuroha/Hinata, Yuki, etc.).
 */
function extractPersonaBlock(text: string): { displayName: string; personaText: string } {
  const allTags = [...text.matchAll(/<([^>]+?)\s*Persona>+/g)];
  const personaTag = allTags.find((m) => m[1].trim().toLowerCase() !== "user") || null;

  const openTag = personaTag ? personaTag[0] : null;
  const displayName = personaTag ? personaTag[1].trim() : "";

  const afterTag = openTag
    ? text.slice(personaTag!.index! + openTag.length)
    : text;
  const personaText = afterTag
    .replace(/<Scenario>[\s\S]*$/i, "")
    .replace(/<UserPersona>[\s\S]*?<\/UserPersona>/gi, "")
    .replace(/<\/UserPersona>/gi, "")
    .trim();

  return { displayName, personaText };
}

/** Strip markdown decoration from a name. */
function cleanName(name: string): string {
  if (!name) return name;
  return String(name)
    .replace(/\*+/g, " ")
    .replace(/^#+\s*/, "")
    .replace(/^["'“”’‘]+|["'“”’‘]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Try multiple patterns to find the character name. */
function extractName(personaText: string, displayName: string): string {
  let m: RegExpMatchArray | null;

  m = personaText.match(/>\*\*Name:\*\*\s*\n?\s*([\s\S]*?)(?=\n>|\n\n>|$)/i);
  if (m && m[1].trim()) return cleanName(m[1].trim().split("\n")[0]);

  m = personaText.match(/[•\-]\s*Name:\s*(.+)/i);
  if (m) return cleanName(m[1].trim());

  m = personaText.match(/\*\*Name:\*\*\s*\n?\s*([\s\S]*?)(?=\n\*\*|\n\n|$)/i);
  if (m && m[1].trim()) return cleanName(m[1].trim().split("\n")[0]);

  m = personaText.match(/^Name:\s*(.+)/im);
  if (m) return cleanName(m[1].trim());

  m = personaText.match(/\*\s*\*\*Identity:\*\*\s*([^,\n]+)/i);
  if (m && m[1].trim()) return cleanName(m[1].trim());

  m = personaText.match(/^#\s+\*{0,2}(.+?)\*{0,2}\s*$/m);
  if (m && m[1].trim()) return cleanName(m[1].trim());

  let fallback = cleanName(displayName);
  fallback = fallback.replace(/'s$/i, "").replace(/s'$/i, "");
  return fallback;
}

/** Extract a field value with various formats */
function extractField(personaText: string, fieldName: string): string {
  let m: RegExpMatchArray | null;

  m = personaText.match(new RegExp(`>\\*\\*${escapeRegex(fieldName)}:\\*\\*\\s*\\n?\\s*([\\s\\S]*?)(?=\\n>|\\n\\n>|$)`, "i"));
  if (m && m[1].trim()) return m[1].trim();

  m = personaText.match(new RegExp(`-\\s*${escapeRegex(fieldName)}:\\s*(.+)`, "i"));
  if (m) return m[1].trim();

  m = personaText.match(new RegExp(`^${escapeRegex(fieldName)}:\\s*(.+)$`, "im"));
  if (m) return m[1].trim();

  m = personaText.match(new RegExp(`\\*\\s*\\*\\*${escapeRegex(fieldName)}:\\*\\*\\s*([^\\n]+)`, "i"));
  if (m) return m[1].trim();

  return "";
}

function extractSections(personaText: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const headingRegex = />\s*([^*\n<][^\n]*)\n([\s\S]*?)(?=>\s*[^*\n<][^\n]*\n|<Scenario>|<UserPersona>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(personaText)) !== null) {
    const heading = m[1].trim();
    if (heading.match(/^Character:/i) || heading.length > 60) continue;
    sections[heading.toLowerCase()] = m[2].trim();
  }
  return sections;
}

function extractCharacterBlocks(personaText: string): Array<{ name: string; data: string }> {
  const chars: Array<{ name: string; data: string }> = [];
  const regex = />\s*Character:\s*(.+?)\n([\s\S]*?)(?=>\s*Character:|>\s*NPC|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(personaText)) !== null) {
    chars.push({ name: m[1].trim(), data: m[2].trim() });
  }
  return chars;
}

/** Clean up Janitor's quote-format markers so the description reads naturally. */
function buildDescription(personaText: string): string {
  let text = personaText.trim();

  text = text.replace(/^>\s*<[^>]+>\s*/, "");
  text = text.replace(/^<[^>]+>\s*/, "");

  text = text.replace(/^>+\s?/gm, "");
  text = text.replace(/^Premise\s*\n*/i, "");
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

/** Main parser — converts Janitor system message + messages array into V2 card. */
export function parseJanitorTextFormat(
  systemContent: string,
  messages: JanitorMessage[],
): V2Card | null {
  const text = typeof systemContent === "string" ? systemContent : "";
  if (!text) return null;

  const { displayName, personaText } = extractPersonaBlock(text);
  if (!personaText) return null;

  const name = extractName(personaText, displayName);
  if (!name) return null;

  const gender = extractField(personaText, "Gender");
  const age = extractField(personaText, "Age");
  const height = extractField(personaText, "Height");
  const appearance = extractField(personaText, "Appearance");
  const sections = extractSections(personaText);
  const characterBlocks = extractCharacterBlocks(personaText);

  const scenarioMatch = text.match(/<Scenario>([\s\S]*?)<\/Scenario>/);
  const scenarioText = scenarioMatch ? scenarioMatch[1].trim() : "";

  const userPersonaMatch = text.match(/<UserPersona>([\s\S]*?)<\/UserPersona>/);
  const userPersona = userPersonaMatch ? userPersonaMatch[1].trim() : "";

  const tooltipMatch = scenarioText.match(/<Tooltip>\s*([\s\S]*?)<\/Tooltip>/i);
  const tooltip = tooltipMatch ? tooltipMatch[1].trim() : "";

  const rulesMatch = scenarioText.match(/<rules>([\s\S]*?)<\/rules>/i);
  const rules = rulesMatch ? rulesMatch[1].trim() : "";

  const genreMatch = scenarioText.match(/^[•\*\-]\s*Genre:\s*(.+)$/im)
                  || scenarioText.match(/^Genre:\s*(.+)$/im);
  const tags = genreMatch ? genreMatch[1].split(",").map((t) => t.trim()).filter(Boolean) : [];

  const settingMatch = scenarioText.match(/^[•\*\-]\s*Setting:\s*(.+?)$/im)
                  || scenarioText.match(/^Setting:\s*(.+?)$/im);
  let setting = settingMatch ? settingMatch[1] : "";
  if (setting) {
    setting = setting
      .replace(/<Tooltip>[\s\S]*?<\/Tooltip>/gi, "")
      .replace(/<rules>[\s\S]*?<\/rules>/gi, "")
      .trim()
      .replace(/\.+$/, "")
      .trim();
  }

  const systemNote = scenarioText
    .replace(/<Tooltip>[\s\S]*?<\/Tooltip>/gi, "")
    .replace(/<rules>[\s\S]*?<\/rules>/gi, "")
    .replace(/^[•\*\-]?\s*Genre:\s*.+$/gim, "")
    .replace(/^[•\*\-]?\s*Setting:\s*.+$/gim, "")
    .replace(/^>+\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const description = buildDescription(personaText);

  const personality = extractField(personaText, "Personality") || sections.personality || "";
  const sexuality = extractField(personaText, "Sexuality") || extractField(personaText, "Sexuality & Intimacy") || sections.sexuality || "";
  const speech = extractField(personaText, "Speech") || extractField(personaText, "Speech Style") || sections.speech || "";

  const systemPromptParts: string[] = [];
  if (tooltip) systemPromptParts.push(tooltip);
  if (rules) systemPromptParts.push(rules);
  if (setting && systemNote) systemPromptParts.push(systemNote);

  const scenario = setting || systemNote;

  const firstAssistant = messages.find((m) => m.role === "assistant");
  const first_mes = firstAssistant ? (typeof firstAssistant.content === "string" ? firstAssistant.content : JSON.stringify(firstAssistant.content)) : "";

  let cleanFirstMes = first_mes.trim();
  let post_history_instructions = "";
  const tildeIdx = cleanFirstMes.indexOf("~~~");
  if (tildeIdx > 0) {
    post_history_instructions = cleanFirstMes.slice(tildeIdx + 3).trim();
    cleanFirstMes = cleanFirstMes.slice(0, tildeIdx).trim();
  }

  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description,
      personality,
      scenario,
      first_mes: cleanFirstMes,
      mes_example: "",
      creator_notes: "",
      system_prompt: systemPromptParts.join("\n\n"),
      post_history_instructions,
      tags,
      creator: "",
      character_version: "1.0",
      alternate_greetings: [],
      extensions: {
        janitor_extras: {
          display_name: displayName,
          gender,
          age,
          height,
          appearance,
          user_persona: userPersona,
          sexuality,
          speech,
          side_characters: characterBlocks,
          full_persona: personaText,
        },
      },
    },
  };
}

/** Normalize arbitrary card shapes to V2 data fields. */
function normalizeCardData(d: any): V2CardData {
  return {
    name: d.name || d.char_name || "",
    description: d.description || d.char_persona || "",
    personality: d.personality || "",
    scenario: d.scenario || d.world_scenario || "",
    first_mes: d.first_mes || d.greeting || "",
    mes_example: d.mes_example || d.example_dialogue || "",
    creator_notes: d.creator_notes || "",
    system_prompt: d.system_prompt || "",
    post_history_instructions: d.post_history_instructions || "",
    tags: d.tags || [],
    creator: d.creator || "",
    character_version: d.character_version || "",
    alternate_greetings: d.alternate_greetings || [],
    extensions: d.extensions || {},
  };
}

/** Try JSON parse strategies */
export function tryParseJsonCard(text: string): V2Card | null {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    if (obj?.spec === "chara_card_v2" && obj.data) return obj;
    if (obj?.data && (obj.data.name || obj.data.char_name)) {
      return { spec: "chara_card_v2", spec_version: "2.0", data: normalizeCardData(obj.data) };
    }
    if (obj?.name || obj?.char_name) {
      return { spec: "chara_card_v2", spec_version: "2.0", data: normalizeCardData(obj) };
    }
  } catch {
    /* fall through */
  }

  // Extract longest JSON-looking blob with name/spec key
  const regex = /\{[\s\S]*?"(?:name|char_name|spec)"[\s\S]*?\}/g;
  let longest: any = null;
  let longestLen = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj && (obj.spec === "chara_card_v2" || obj.name || obj.char_name || obj.data?.name)) {
        if (match[0].length > longestLen) {
          longest = obj;
          longestLen = match[0].length;
        }
      }
    } catch {
      /* try next */
    }
  }
  if (longest) {
    if (longest.spec === "chara_card_v2" && longest.data) return longest;
    return { spec: "chara_card_v2", spec_version: "2.0", data: normalizeCardData(longest.data || longest) };
  }
  return null;
}

/** Extract all image URLs from messages (markdown images + bare Janitor CDN URLs). */
export function extractImageUrls(messages: JanitorMessage[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (!text) continue;

    const mdRegex = /!?\[[^\]]*\]\((https?:\/\/[^)\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = mdRegex.exec(text)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); urls.push(m[1]); }
    }

    const bareRegex = /https?:\/\/(?:ella\.|media\.)?janitorai\.com\/[^\s)'"<>]+/gi;
    while ((m = bareRegex.exec(text)) !== null) {
      if (!seen.has(m[0])) { seen.add(m[0]); urls.push(m[0]); }
    }
  }

  return urls;
}

/** Main extraction: try JSON first, then Janitor text format */
export function extractCard(messages: JanitorMessage[]): V2Card | null {
  const systemMsg = messages.find((m) => m.role === "system");
  const systemText = systemMsg ? (typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content)) : "";

  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const jsonCard = tryParseJsonCard(text);
    if (jsonCard) return jsonCard;
  }

  if (systemText) {
    const parsed = parseJanitorTextFormat(systemText, messages);
    if (parsed?.data?.name) return parsed;
  }
  return null;
}

/** Simple hash for dedup */
export function hashContent(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Hash only the persona definition (stable across greeting changes) */
export function hashPersona(systemContent: string): string | null {
  if (!systemContent) return null;
  const personaMatch = systemContent.match(/<[^>]*Persona>+([\s\S]*?)(?:<Scenario>|<UserPersona>|$)/i);
  if (personaMatch) return hashContent(personaMatch[1]);
  const cut = systemContent.search(/<Scenario>|<UserPersona>/i);
  if (cut > 0) return hashContent(systemContent.slice(0, cut));
  return hashContent(systemContent);
}

/** Slugify a string for URLs (preserves Unicode letters). */
export function slugify(str: string): string {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/\-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export { autoTagCard };
