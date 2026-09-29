/**
 * Render a card field value for display in a diff.
 *
 * Card values are strings or arrays of strings; arrays are joined so a list
 * field reads as one block rather than "[object Object]".
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)'
  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty list)'
    return value.map((v, i) => `${i + 1}. ${String(v)}`).join('\n')
  }
  const text = String(value)
  return text.trim().length === 0 ? '(empty)' : text
}

/** Short single-line preview for collapsed rows. */
export function previewValue(value: unknown, max = 120): string {
  const text = formatValue(value).replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function relativeTime(unixSeconds: number): string {
  const delta = Math.floor(Date.now() / 1000) - unixSeconds
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}
