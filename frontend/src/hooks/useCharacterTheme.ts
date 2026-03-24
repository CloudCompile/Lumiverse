/**
 * Two responsibilities:
 *
 * 1. **Character name colors** (always active): Extracts a palette from the active
 *    character's avatar and sets `--char-name-dark` / `--char-name-light` on the root.
 *    These are vibrant, theme-mode-aware name colors used in chat messages.
 *
 * 2. **Character-aware theme overlay** (opt-in via `characterAware: true`): Merges
 *    accent + base colors derived from the avatar onto the current theme.
 */

import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { getCharacterAvatarUrlById } from '@/lib/avatarUrls'
import { extractPalette, type ImagePalette } from '@/lib/colorExtraction'
import { deriveCharacterOverlay, deriveCharacterNameVars } from '@/lib/characterTheme'
import type { ThemeConfig } from '@/types/theme'

/** In-memory palette cache keyed by avatar identity to avoid re-extraction. */
const paletteCache = new Map<string, ImagePalette>()

/** Keys we set on the root so we can clean them up. */
const NAME_VAR_KEYS = ['--char-name-dark', '--char-name-light']

export function useCharacterTheme() {
  const characterAware = useStore((s) => (s.theme as ThemeConfig | null)?.characterAware === true)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const activeCharacter = activeCharacterId
    ? characters.find((entry) => entry.id === activeCharacterId) ?? null
    : null
  const avatarUrl = getCharacterAvatarUrlById(activeCharacterId, activeCharacter?.image_id ?? null)
  const avatarCacheKey = activeCharacterId
    ? `${activeCharacterId}:${activeCharacter?.image_id ?? 'legacy'}:${activeCharacter?.avatar_path ?? 'none'}`
    : null
  const appliedAvatarKeyRef = useRef<string | null>(null)
  const nameAppliedAvatarKeyRef = useRef<string | null>(null)

  // ── 1. Character name colors (always active) ──
  useEffect(() => {
    const root = document.documentElement

    if (!activeCharacterId || !avatarUrl || !avatarCacheKey) {
      NAME_VAR_KEYS.forEach((k) => root.style.removeProperty(k))
      nameAppliedAvatarKeyRef.current = null
      return
    }

    if (nameAppliedAvatarKeyRef.current === avatarCacheKey) return

    let cancelled = false

    const apply = async () => {
      try {
        let palette = paletteCache.get(avatarCacheKey)
        if (!palette) {
          palette = await extractPalette(avatarUrl)
          paletteCache.set(avatarCacheKey, palette)
        }

        if (cancelled) return

        const vars = deriveCharacterNameVars(palette)
        for (const [key, value] of Object.entries(vars)) {
          root.style.setProperty(key, value)
        }
        nameAppliedAvatarKeyRef.current = avatarCacheKey
      } catch (err) {
        console.warn('[useCharacterTheme] Name color extraction failed:', err)
      }
    }

    apply()
    return () => { cancelled = true }
  }, [activeCharacterId, avatarUrl, avatarCacheKey])

  // ── 2. Character-aware theme overlay (opt-in) ──
  useEffect(() => {
    if (!characterAware) {
      appliedAvatarKeyRef.current = null
      return
    }

    if (!activeCharacterId || !avatarUrl || !avatarCacheKey) return
    if (appliedAvatarKeyRef.current === avatarCacheKey) return

    let cancelled = false

    const apply = async () => {
      try {
        let palette = paletteCache.get(avatarCacheKey)
        if (!palette) {
          palette = await extractPalette(avatarUrl)
          paletteCache.set(avatarCacheKey, palette)
        }

        if (cancelled) return

        const overlay = deriveCharacterOverlay(palette)

        const current = useStore.getState().theme as ThemeConfig | null
        if (!current?.characterAware) return

        appliedAvatarKeyRef.current = avatarCacheKey

        useStore.getState().setTheme({
          ...current,
          accent: overlay.accent,
          baseColors: {
            ...current.baseColors,
            ...overlay.baseColors,
          },
        })
      } catch (err) {
        console.warn('[useCharacterTheme] Theme overlay failed:', err)
      }
    }

    apply()
    return () => { cancelled = true }
  }, [characterAware, activeCharacterId, avatarUrl, avatarCacheKey])
}
