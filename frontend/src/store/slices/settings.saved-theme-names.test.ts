/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test'
import type { AppStore, SavedThemePackEntry } from '@/types/store'
import { DEFAULT_THEME } from '@/theme/presets'
import { createSettingsSlice, resetSettingsPersistence } from './settings'

function createStore(): AppStore {
  const state = {} as AppStore
  const set = (partial: Partial<AppStore> | ((current: AppStore) => Partial<AppStore>)) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const get = () => state
  Object.assign(state, createSettingsSlice(set as never, get, {} as never))
  return state
}

function legacyPack(name = 'Slate'): SavedThemePackEntry['pack'] {
  return {
    format: 2,
    name,
    author: '',
    description: '',
    createdAt: 1,
    bundleId: 'bundle-1',
    theme: { ...DEFAULT_THEME, id: 'slate', name },
    globalCSS: '.root { color: white; }',
    components: {},
    assets: [],
  }
}

afterEach(() => {
  resetSettingsPersistence()
})

describe('saved theme names', () => {
  test('renaming an active bundle synchronizes the saved pack and live theme name', () => {
    const store = createStore()
    store.theme = { ...DEFAULT_THEME, id: 'slate', name: 'Slate' }
    store.customCSS = { ...store.customCSS, bundleId: 'bundle-1' }
    store.savedThemes = [{
      kind: 'pack',
      id: 'saved-pack',
      name: 'Slate',
      createdAt: 1,
      pack: legacyPack(),
    }]

    store.renameSavedTheme('saved-pack', 'Starry Elegance')

    const saved = store.savedThemes[0]
    expect(saved.name).toBe('Starry Elegance')
    expect(saved.kind).toBe('pack')
    if (saved.kind !== 'pack') throw new Error('Expected pack entry')
    expect(saved.pack.name).toBe('Starry Elegance')
    expect(saved.pack.theme?.name).toBe('Starry Elegance')
    expect(store.theme?.name).toBe('Starry Elegance')
  })

  test('applying legacy saved entries promotes the visible library name to the live theme', () => {
    const store = createStore()
    store.theme = { ...DEFAULT_THEME, name: 'Lumiverse Purple' }
    store.savedThemes = [
      {
        kind: 'config',
        id: 'saved-config',
        name: 'Void Bloom',
        createdAt: 1,
        theme: { ...DEFAULT_THEME, id: 'slate', name: 'Slate' },
      },
      {
        kind: 'pack',
        id: 'saved-pack',
        name: 'Honeyed Twilight',
        createdAt: 1,
        pack: legacyPack(),
      },
    ]

    store.applySavedTheme('saved-config')
    expect(store.theme?.name).toBe('Void Bloom')

    store.applySavedTheme('saved-pack')
    expect(store.theme?.name).toBe('Honeyed Twilight')
    expect(store.customCSS.bundleId).toBe('bundle-1')
  })
})
