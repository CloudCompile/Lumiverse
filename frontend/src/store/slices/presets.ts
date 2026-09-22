import type { StateCreator } from 'zustand'
import type { PresetsSlice } from '@/types/store'

export const createPresetsSlice: StateCreator<PresetsSlice> = (set, get) => ({
  presets: {},
  activePresetId: null,
  activeLoomPresetId: null,
  loomRegistry: {},

  setPresets: (presets) => set({ presets }),
  setActivePreset: (id) => set({ activePresetId: id }),
  setActiveLoomPreset: (id) => {
    const { setSetting } = get() as any
    // setSetting owns both the state update and persistence. Updating the
    // state first made setSetting see a no-op, so preset switches were never
    // written to the server and could resurrect an old preset after reload.
    if (setSetting) {
      setSetting('activeLoomPresetId', id)
    } else {
      set({ activeLoomPresetId: id })
    }
  },
  setLoomRegistry: (registry) => set({ loomRegistry: registry }),
  getActivePresetForGeneration: () => get().activeLoomPresetId || null,
})
