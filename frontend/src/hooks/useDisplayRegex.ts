import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { applyDisplayRegex, applyDisplayRegexAsync } from '@/lib/regex/compiler'
import { resolveMacrosBatch } from '@/api/macros'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'

interface ResolvedDisplayRegexTemplates {
  resolvedFindPatterns: Map<string, string>
  resolvedReplacements: Map<string, string>
}

interface DisplayRegexCacheEntry {
  value?: ResolvedDisplayRegexTemplates
  promise?: Promise<ResolvedDisplayRegexTemplates>
}

interface DisplayRegexContentCacheEntry {
  value?: string
  promise?: Promise<string>
}

const displayRegexResolutionCache = new Map<string, DisplayRegexCacheEntry>()
const displayRegexContentCache = new Map<string, DisplayRegexContentCacheEntry>()
const displayRegexCacheListeners = new Set<() => void>()
let displayRegexCacheVersion = 0

/** Quick check for macro syntax in a string. */
function hasMacroSyntax(s: string): boolean {
  return s.includes('{{') || s.includes('<USER>') || s.includes('<BOT>') || s.includes('<CHAR>')
}

function createEmptyResolvedTemplates(): ResolvedDisplayRegexTemplates {
  return {
    resolvedFindPatterns: new Map(),
    resolvedReplacements: new Map(),
  }
}

function subscribeDisplayRegexCache(listener: () => void): () => void {
  displayRegexCacheListeners.add(listener)
  return () => displayRegexCacheListeners.delete(listener)
}

function getDisplayRegexCacheVersion(): number {
  return displayRegexCacheVersion
}

export function invalidateDisplayRegexCache(): void {
  displayRegexCacheVersion += 1
  displayRegexResolutionCache.clear()
  displayRegexContentCache.clear()
  for (const listener of displayRegexCacheListeners) listener()
}

async function resolveMacrosBatchChunked(
  templates: Record<string, string>,
  context: {
    chat_id?: string
    character_id?: string
    persona_id?: string
  },
): Promise<Record<string, string>> {
  const entries = Object.entries(templates)
  if (entries.length === 0) return {}

  const chunkPromises: Array<Promise<Record<string, string>>> = []
  for (let i = 0; i < entries.length; i += 100) {
    chunkPromises.push(
      resolveMacrosBatch({
        templates: Object.fromEntries(entries.slice(i, i + 100)),
        ...context,
      }).then((res) => res.resolved),
    )
  }

  const chunks = await Promise.all(chunkPromises)
  return Object.assign({}, ...chunks)
}

export function useDisplayRegex(content: string, isUser: boolean, depth: number, macroCtx?: DisplayMacroContext): string {
  const regexScripts = useStore((s) => s.regexScripts)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const cacheVersion = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getDisplayRegexCacheVersion,
    getDisplayRegexCacheVersion,
  )

  const displayScripts = useMemo(
    () =>
      regexScripts.filter(
        (s) =>
          s.target === 'display' &&
          !s.disabled &&
          (s.scope === 'global' ||
            (s.scope === 'character' && s.scope_id === activeCharacterId) ||
            (s.scope === 'chat' && s.scope_id === activeChatId)),
      ),
    [regexScripts, activeCharacterId, activeChatId],
  )

  // Collect display scripts that need backend macro resolution
  const scriptsNeedingResolution = useMemo(
    () =>
      displayScripts.filter(
        (s) => s.substitute_macros !== 'none' && (hasMacroSyntax(s.find_regex) || hasMacroSyntax(s.replace_string)),
      ),
    [displayScripts],
  )

  // Pre-resolve find patterns and non-raw replacement strings via the backend macro engine.
  // Raw replacements stay per-match so capture groups remain available before macro evaluation.
  const [resolvedTemplates, setResolvedTemplates] = useState<ResolvedDisplayRegexTemplates>(createEmptyResolvedTemplates)
  const [resolvedContent, setResolvedContent] = useState<string | null>(null)

  useEffect(() => {
    if (scriptsNeedingResolution.length === 0) {
      setResolvedTemplates((current) =>
        current.resolvedFindPatterns.size === 0 && current.resolvedReplacements.size === 0
          ? current
          : createEmptyResolvedTemplates(),
      )
      return
    }

    const templates: Record<string, string> = {}
    for (const s of scriptsNeedingResolution) {
      if (hasMacroSyntax(s.find_regex)) {
        templates[`find:${s.id}`] = s.find_regex
      }
      if (s.substitute_macros !== 'raw' && hasMacroSyntax(s.replace_string)) {
        templates[`replace:${s.id}`] = s.replace_string
      }
    }

    const templateEntries = Object.entries(templates)
    if (templateEntries.length === 0) {
      setResolvedTemplates((current) =>
        current.resolvedFindPatterns.size === 0 && current.resolvedReplacements.size === 0
          ? current
          : createEmptyResolvedTemplates(),
      )
      return
    }

    const cacheKey = JSON.stringify({
      cacheVersion,
      activeChatId,
      activeCharacterId,
      activePersonaId,
      scripts: scriptsNeedingResolution.map((s) => [
        s.id,
        s.updated_at,
        s.find_regex,
        s.replace_string,
        s.substitute_macros,
      ]),
    })

    let cancelled = false

    const applyResolvedTemplates = (next: ResolvedDisplayRegexTemplates) => {
      if (!cancelled) setResolvedTemplates(next)
    }

    const cached = displayRegexResolutionCache.get(cacheKey)
    if (cached?.value) {
      applyResolvedTemplates(cached.value)
      return () => { cancelled = true }
    }

    if (!cached?.promise) {
      const promise = resolveMacrosBatch({
        templates,
        chat_id: activeChatId ?? undefined,
        character_id: activeCharacterId ?? undefined,
        persona_id: activePersonaId ?? undefined,
      })
        .then((res) => {
          const next = createEmptyResolvedTemplates()
          for (const [key, value] of Object.entries(res.resolved)) {
            if (key.startsWith('find:')) {
              next.resolvedFindPatterns.set(key.slice(5), value)
            } else if (key.startsWith('replace:')) {
              next.resolvedReplacements.set(key.slice(8), value)
            }
          }
          displayRegexResolutionCache.set(cacheKey, { value: next })
          return next
        })
        .catch(() => {
          displayRegexResolutionCache.delete(cacheKey)
          return createEmptyResolvedTemplates()
        })

      displayRegexResolutionCache.set(cacheKey, { promise })
    }

    displayRegexResolutionCache.get(cacheKey)?.promise?.then(applyResolvedTemplates)

    return () => { cancelled = true }
  }, [scriptsNeedingResolution, activeChatId, activeCharacterId, activePersonaId, cacheVersion])

  const fallbackContent = useMemo(
    () => {
      if (displayScripts.length === 0) return content
      return applyDisplayRegex(content, displayScripts, {
        isUser,
        depth,
        macroCtx,
        resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
        resolvedReplacements: resolvedTemplates.resolvedReplacements,
      })
    },
    [content, displayScripts, isUser, depth, macroCtx, resolvedTemplates],
  )

  const hasRawMacroScripts = useMemo(
    () => displayScripts.some((s) => s.substitute_macros === 'raw'),
    [displayScripts],
  )

  const resolvedTemplateKey = useMemo(
    () => JSON.stringify({
      find: Array.from(resolvedTemplates.resolvedFindPatterns.entries()),
      replace: Array.from(resolvedTemplates.resolvedReplacements.entries()),
    }),
    [resolvedTemplates],
  )

  useEffect(() => {
    if (displayScripts.length === 0 || !hasRawMacroScripts) {
      setResolvedContent((current) => current === null ? current : null)
      return
    }

    const cacheKey = JSON.stringify({
      cacheVersion,
      activeChatId,
      activeCharacterId,
      activePersonaId,
      isUser,
      depth,
      userName: macroCtx?.userName ?? null,
      charName: macroCtx?.charName ?? null,
      content,
      resolvedTemplateKey,
      scripts: displayScripts.map((s) => [
        s.id,
        s.updated_at,
        s.find_regex,
        s.replace_string,
        s.flags,
        s.placement,
        s.min_depth,
        s.max_depth,
        s.trim_strings,
        s.substitute_macros,
      ]),
    })

    let cancelled = false
    const applyResolvedContent = (next: string) => {
      if (!cancelled) setResolvedContent(next)
    }

    const cached = displayRegexContentCache.get(cacheKey)
    if (cached?.value !== undefined) {
      applyResolvedContent(cached.value)
      return () => { cancelled = true }
    }

    if (!cached?.promise) {
      const promise = applyDisplayRegexAsync(
        content,
        displayScripts,
        {
          isUser,
          depth,
          macroCtx,
          resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
          resolvedReplacements: resolvedTemplates.resolvedReplacements,
        },
        (templates) => resolveMacrosBatchChunked(templates, {
          chat_id: activeChatId ?? undefined,
          character_id: activeCharacterId ?? undefined,
          persona_id: activePersonaId ?? undefined,
        }),
      )
        .then((next) => {
          displayRegexContentCache.set(cacheKey, { value: next })
          return next
        })
        .catch(() => {
          displayRegexContentCache.delete(cacheKey)
          return fallbackContent
        })

      displayRegexContentCache.set(cacheKey, { promise })
    }

    displayRegexContentCache.get(cacheKey)?.promise?.then(applyResolvedContent)

    return () => { cancelled = true }
  }, [
    content,
    isUser,
    depth,
    macroCtx,
    fallbackContent,
    displayScripts,
    hasRawMacroScripts,
    resolvedTemplateKey,
    resolvedTemplates,
    activeChatId,
    activeCharacterId,
    activePersonaId,
    cacheVersion,
  ])

  return resolvedContent ?? fallbackContent
}
