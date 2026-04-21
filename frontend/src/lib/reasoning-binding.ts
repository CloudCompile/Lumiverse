import type { ReasoningSettings } from '@/types/store'

const REASONING_PRESETS: Array<{ label: string; prefix: string; suffix: string }> = [
  { label: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>' },
  { label: 'Claude', prefix: '<thinking>\n', suffix: '\n</thinking>' },
  { label: 'o1', prefix: '<reasoning>\n', suffix: '\n</reasoning>' },
]

function formatTagValue(value: string): string {
  const compact = value.replace(/\n/g, '\\n') || '(empty)'
  return compact.length > 40 ? `${compact.slice(0, 37)}...` : compact
}

export function getReasoningPresetLabel(settings: ReasoningSettings): string | null {
  return REASONING_PRESETS.find((preset) => (
    preset.prefix === settings.prefix && preset.suffix === settings.suffix
  ))?.label ?? null
}

export function getReasoningBindingSummary(settings: ReasoningSettings): string {
  const parts: string[] = []
  const presetLabel = getReasoningPresetLabel(settings)

  parts.push(presetLabel ? `${presetLabel} tags` : 'Custom tags')
  parts.push(settings.apiReasoning ? 'API reasoning on' : 'API reasoning off')

  if (settings.apiReasoning || settings.reasoningEffort !== 'auto') {
    parts.push(`effort ${settings.reasoningEffort}`)
  }

  if (settings.keepInHistory === -1) {
    parts.push('keep all history')
  } else if (settings.keepInHistory === 0) {
    parts.push('strip history')
  } else {
    parts.push(`keep ${settings.keepInHistory} history`)
  }

  if (!settings.autoParse) parts.push('manual parse')
  if (settings.thinkingDisplay !== 'auto') parts.push(`display ${settings.thinkingDisplay}`)

  return parts.join(' · ')
}

export function getReasoningBindingTitle(settings: ReasoningSettings): string {
  return [
    getReasoningBindingSummary(settings),
    `Prefix: ${formatTagValue(settings.prefix)}`,
    `Suffix: ${formatTagValue(settings.suffix)}`,
  ].join('\n')
}

export function areReasoningSettingsEqual(a: ReasoningSettings, b: ReasoningSettings): boolean {
  return a.prefix === b.prefix
    && a.suffix === b.suffix
    && a.autoParse === b.autoParse
    && a.apiReasoning === b.apiReasoning
    && a.reasoningEffort === b.reasoningEffort
    && a.keepInHistory === b.keepInHistory
    && a.thinkingDisplay === b.thinkingDisplay
}
