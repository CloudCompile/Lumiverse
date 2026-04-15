import type { SpeechDetectionRules } from '@/types/store'

export type SegmentType = 'asterisked' | 'quoted' | 'undecorated'
export type SegmentAction = 'speech' | 'narration' | 'skip'

/**
 * Loom/Lumia meta tags. Content wrapped in these never belongs in TTS —
 * it's state, memory, or UI scaffolding.
 */
const LOOM_META_TAGS = [
  'loom_sum', 'loom_if', 'loom_else', 'loom_endif',
  'lumia_ooc', 'lumiaooc', 'lumio_ooc', 'lumioooc',
  'loom_state', 'loom_memory', 'loom_context', 'loom_inject',
  'loom_var', 'loom_set', 'loom_get',
  'loom_record', 'loomrecord', 'loom_ledger', 'loomledger',
]

const REASONING_TAGS = ['think', 'thinking', 'reasoning']

// Paired tag stripper (greedy over inner content). Built once per run.
function buildPairedStripper(tags: string[]): RegExp {
  return new RegExp(`<(${tags.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi')
}

// Self-closing / unpaired variant — drop the tag but not surrounding content.
function buildSelfClosingStripper(tags: string[]): RegExp {
  return new RegExp(`<(${tags.join('|')})(?:\\s[^>]*)?\\/?>`, 'gi')
}

const REASONING_PAIRED_RE = buildPairedStripper(REASONING_TAGS)
const REASONING_UNCLOSED_RE = new RegExp(`<(${REASONING_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*$`, 'i')
const LOOM_PAIRED_RE = buildPairedStripper(LOOM_META_TAGS)
const LOOM_SELF_RE = buildSelfClosingStripper(LOOM_META_TAGS)
const DETAILS_PAIRED_RE = /<details(?:\s[^>]*)?>[\s\S]*?<\/details>/gi
const DETAILS_UNCLOSED_RE = /<details(?:\s[^>]*)?>[\s\S]*$/i
const FENCED_CODE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`\n]*`/g
const MD_IMAGE_RE = /!\[[^\]]*]\([^)]*\)/g
const MD_LINK_RE = /\[([^\]]+)]\([^)]+\)/g
const REMAINING_HTML_RE = /<\/?[a-z][^>]*>/gi
const HTML_ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&lsquo;': "'",
  '&rsquo;': "'",
}
const HTML_ENTITY_RE = /&(?:nbsp|amp|lt|gt|quot|apos|#39|ldquo|rdquo|lsquo|rsquo);/g

/**
 * Remove anything that reads poorly (or nonsensically) when spoken:
 * reasoning/thinking blocks, Loom meta tags, `<details>` collapsibles,
 * fenced/inline code, markdown image markers, and any remaining HTML.
 *
 * Inner text is preserved for display-oriented HTML (e.g. `<b>hi</b>` → `hi`),
 * but discarded for containers whose contents are meta-UI rather than prose.
 */
export function sanitizeForTts(text: string): string {
  let out = text

  // 1. Reasoning blocks — drop the whole thing (content is meta, not spoken prose).
  out = out.replace(REASONING_PAIRED_RE, ' ')
  out = out.replace(REASONING_UNCLOSED_RE, ' ') // interrupted stream

  // 2. <details> blocks — typically tool calls / collapsed reasoning.
  out = out.replace(DETAILS_PAIRED_RE, ' ')
  out = out.replace(DETAILS_UNCLOSED_RE, ' ')

  // 3. Loom/Lumia meta tags — drop paired content AND self-closing markers.
  out = out.replace(LOOM_PAIRED_RE, ' ')
  out = out.replace(LOOM_SELF_RE, ' ')

  // 4. Code — fenced first (multiline), then inline.
  out = out.replace(FENCED_CODE_RE, ' ')
  out = out.replace(INLINE_CODE_RE, ' ')

  // 5. Markdown images dropped; links kept as their label text.
  out = out.replace(MD_IMAGE_RE, ' ')
  out = out.replace(MD_LINK_RE, '$1')

  // 6. Any remaining HTML tags — strip the tag, keep inner text.
  out = out.replace(REMAINING_HTML_RE, ' ')

  // 7. Decode a handful of common HTML entities so they're pronounced, not spelled.
  out = out.replace(HTML_ENTITY_RE, (m) => HTML_ENTITY_MAP[m] ?? m)

  // 8. Collapse whitespace (including newlines) into single spaces.
  out = out.replace(/\s+/g, ' ').trim()

  return out
}

export interface TextSegment {
  text: string
  type: SegmentType
  action: SegmentAction
}

function resolveAction(type: SegmentType, rules: SpeechDetectionRules): SegmentAction {
  switch (type) {
    case 'asterisked':
      return rules.asterisked === 'skip' ? 'skip' : 'narration'
    case 'quoted':
      return rules.quoted
    case 'undecorated':
      return rules.undecorated
  }
}

/**
 * Parse raw message text into classified segments.
 *
 * - *text between asterisks* → asterisked
 * - "text between quotes" → quoted
 * - everything else → undecorated
 *
 * Each segment is assigned an action based on the user's speech detection rules.
 */
export function parseSegments(text: string, rules: SpeechDetectionRules): TextSegment[] {
  const pattern = /\*([^*]+)\*|"([^"]+)"|([^*"]+)/g
  const raw: TextSegment[] = []

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) {
      const trimmed = match[1].trim()
      if (trimmed) {
        const type: SegmentType = 'asterisked'
        raw.push({ text: trimmed, type, action: resolveAction(type, rules) })
      }
    } else if (match[2] !== undefined) {
      const trimmed = match[2].trim()
      if (trimmed) {
        const type: SegmentType = 'quoted'
        raw.push({ text: trimmed, type, action: resolveAction(type, rules) })
      }
    } else if (match[3] !== undefined) {
      const trimmed = match[3].trim()
      if (trimmed) {
        const type: SegmentType = 'undecorated'
        raw.push({ text: trimmed, type, action: resolveAction(type, rules) })
      }
    }
  }

  // Merge adjacent segments with the same action
  const merged: TextSegment[] = []
  for (const seg of raw) {
    const last = merged[merged.length - 1]
    if (last && last.action === seg.action && last.type === seg.type) {
      last.text += ' ' + seg.text
    } else {
      merged.push({ ...seg })
    }
  }

  return merged
}

/**
 * Filter and concatenate segments that should be spoken aloud.
 * Returns the text string to send to TTS, or null if nothing to speak.
 *
 * The input is first sanitized (HTML tags, reasoning/loom meta, code fences,
 * etc. removed) so the segment parser only sees prose.
 */
export function getSpokenText(text: string, rules: SpeechDetectionRules): string | null {
  const cleaned = sanitizeForTts(text)
  if (!cleaned) return null
  const segments = parseSegments(cleaned, rules)
  const spoken = segments
    .filter((s) => s.action !== 'skip')
    .map((s) => s.text)
    .join(' ')
    .trim()
  return spoken || null
}
