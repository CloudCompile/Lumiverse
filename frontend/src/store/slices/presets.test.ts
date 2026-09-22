import { describe, expect, test } from 'bun:test'
import { createPresetsSlice } from './presets'

describe('presets slice', () => {
  test('persists a Loom preset switch before exposing it in state', () => {
    let state: Record<string, any> = {}
    const set = (patch: Record<string, any>) => { Object.assign(state, patch) }
    const get = () => state
    const persistCalls: Array<{ previous: string | null; id: string | null }> = []

    Object.assign(state, createPresetsSlice(set as any, get as any, {} as any))
    state.setSetting = (_key: string, id: string | null) => {
      persistCalls.push({ previous: state.activeLoomPresetId, id })
      state.activeLoomPresetId = id
    }

    state.setActiveLoomPreset('preset-b')

    expect(persistCalls).toEqual([{ previous: null, id: 'preset-b' }])
    expect(state.activeLoomPresetId).toBe('preset-b')
  })
})
