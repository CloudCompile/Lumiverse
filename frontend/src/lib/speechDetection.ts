import type { SpeechDetectionRules } from '@/types/store'

export type SegmentType = 'asterisked' | 'quoted' | 'undecorated'
export type SegmentAction = 'speech' | 'narration' | 'skip'

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
 */
export function getSpokenText(text: string, rules: SpeechDetectionRules): string | null {
  const segments = parseSegments(text, rules)
  const spoken = segments
    .filter((s) => s.action !== 'skip')
    .map((s) => s.text)
    .join(' ')
    .trim()
  return spoken || null
}
