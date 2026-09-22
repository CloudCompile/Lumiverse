import { regexApi } from '@/api/regex'
import type { RegexScript } from '@/types/regex'

// Client-side evidence for isolated display-regex execution. Quarantine is the
// only signal here because it is the only one that changes execution: a script
// that hung the worker gets skipped until the user clears it. Successful
// timings were deliberately dropped rather than persisted — one fast input
// cannot prove a backtracking pattern is safe on the next input, so ok-evidence
// could never promote a script to a cheaper tier and only produced write
// traffic plus metadata nobody read.
export interface RegexScriptEvidence {
  quarantined?: boolean
}

export type RegexExecTier = 'quarantined' | 'worker'

// Session-scoped overlay. Entries carry a definition fingerprint so that after
// a script edit the overlay is rebuilt from the server row instead of trusting
// a stale in-memory entry. Quarantine itself survives edits (the backend keeps
// the flag and this re-read picks it back up); the fingerprint exists so the
// overlay and the persisted row cannot drift apart across an edit.
const sessionEvidence = new Map<string, { definitionKey: string; evidence: RegexScriptEvidence }>()

// Quarantine is mutated from the async pipeline, outside React's knowledge, so
// the panel needs an explicit subscription to re-render. A version counter is
// enough: components read the current state through isRegexScriptQuarantined()
// and only need a signal that something changed. Storing snapshots per script
// id was rejected — useSyncExternalStore requires a referentially stable
// snapshot, and per-script objects would have to be memoised anyway.
let evidenceVersion = 0
const evidenceListeners = new Set<() => void>()

// Once-per-script toast dedupe for skipped scripts. This lives here rather than
// in pipeline.ts because clearRegexScriptQuarantine() has to reset it, and
// pipeline.ts already imports this module — importing back the other way would
// create a cycle. pipeline.ts still owns the actual warning it emits.
const announcedSkipKeys = new Set<string>()

function definitionKey(script: RegexScript): string {
  return JSON.stringify([
    script.updated_at,
    script.find_regex,
    script.replace_string,
    script.flags,
    script.trim_strings,
    script.substitute_macros,
    script.actions,
    script.metadata?.match_actions,
  ])
}

function readStoredEvidence(script: RegexScript): RegexScriptEvidence {
  const raw = script.metadata?.regex_evidence
  if (!raw || typeof raw !== 'object') return {}
  const evidence: RegexScriptEvidence = {}
  if (raw.quarantined === true) evidence.quarantined = true
  return evidence
}

function notifyEvidenceChanged(): void {
  evidenceVersion += 1
  // Copy first: a listener may unsubscribe while being notified.
  for (const listener of [...evidenceListeners]) listener()
}

export function subscribeRegexEvidence(listener: () => void): () => void {
  evidenceListeners.add(listener)
  return () => {
    evidenceListeners.delete(listener)
  }
}

export function getRegexEvidenceVersion(): number {
  return evidenceVersion
}

export function readRegexScriptEvidence(script: RegexScript): RegexScriptEvidence {
  const key = definitionKey(script)
  const entry = sessionEvidence.get(script.id)
  if (entry?.definitionKey === key) return entry.evidence
  const evidence = readStoredEvidence(script)
  // Deliberately no notifyEvidenceChanged() here: this runs during render, and
  // bumping the version from a read would loop useSyncExternalStore consumers.
  sessionEvidence.set(script.id, { definitionKey: key, evidence })
  return evidence
}

export function getRegexExecTier(script: RegexScript): { tier: RegexExecTier; reason: string } {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return { tier: 'quarantined', reason: 'quarantined' }
  return { tier: 'worker', reason: 'user-authored regexes require isolated execution' }
}

export function isRegexScriptQuarantined(script: RegexScript): boolean {
  return readRegexScriptEvidence(script).quarantined === true
}

// True the first time a given script is skipped, false afterwards, so the
// pipeline warns once per script per session instead of on every message.
export function shouldAnnounceRegexSkip(scriptId: string): boolean {
  if (announcedSkipKeys.has(scriptId)) return false
  announcedSkipKeys.add(scriptId)
  return true
}

export function quarantineRegexScript(script: RegexScript): void {
  const evidence = readRegexScriptEvidence(script)
  if (evidence.quarantined) return
  evidence.quarantined = true
  sessionEvidence.set(script.id, { definitionKey: definitionKey(script), evidence })
  void regexApi.reportEvidence(script.id, { quarantined: true }).catch(() => {
    // Best-effort persistence: extension-owned scripts may reject the write.
    // The session overlay keeps tiering correct regardless.
  })
  notifyEvidenceChanged()
}

/**
 * User-facing escape hatch from quarantine. The overlay is cleared immediately
 * and the persisted flag is deleted server-side (report-evidence removes the
 * key on `quarantined: false`). The returned promise rejects on a failed write
 * so the caller can surface it.
 *
 * The overlay is cleared before the write settles on purpose. Waiting for the
 * server would leave the script skipped for the rest of the session on a failed
 * write even though the user explicitly asked to retry it; clearing first means
 * the retry happens, and a script that hangs again simply re-quarantines.
 */
export function clearRegexScriptQuarantine(script: RegexScript): Promise<void> {
  const evidence = readRegexScriptEvidence(script)
  delete evidence.quarantined
  sessionEvidence.set(script.id, { definitionKey: definitionKey(script), evidence })
  // A deliberate retry earns a fresh warning if the script hangs again.
  announcedSkipKeys.delete(script.id)
  notifyEvidenceChanged()
  return regexApi.reportEvidence(script.id, { quarantined: false }).then(() => undefined)
}

export function resetRegexSkipAnnouncementsForTests(): void {
  announcedSkipKeys.clear()
}

export function resetRegexEvidenceForTests(): void {
  sessionEvidence.clear()
  announcedSkipKeys.clear()
}
