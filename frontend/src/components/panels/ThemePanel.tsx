import { useCallback } from 'react'
import { useStore } from '@/store'
import { DEFAULT_THEME } from '@/theme/presets'
import type { ThemeConfig, ThemeMode, BaseColors } from '@/types/theme'
import ModeSelector from './theme-panel/ModeSelector'
import PresetGrid from './theme-panel/PresetGrid'
import AccentPicker from './theme-panel/AccentPicker'
import BaseColorPicker from './theme-panel/BaseColorPicker'
import DepthControls from './theme-panel/DepthControls'
import styles from './ThemePanel.module.css'

export default function ThemePanel() {
  const theme = useStore((s) => s.theme) as ThemeConfig | null
  const setTheme = useStore((s) => s.setTheme)

  const current = theme ?? DEFAULT_THEME

  const update = useCallback(
    (patch: Partial<ThemeConfig>) => {
      const next = { ...current, ...patch }
      // characterAware themes dynamically derive accent/baseColors from the
      // active character, so keep the preset id so the selection is preserved
      if (!next.characterAware) {
        next.id = 'custom'
      }
      setTheme(next as ThemeConfig)
    },
    [current, setTheme]
  )

  const handleModeChange = useCallback(
    (mode: ThemeMode) => update({ mode }),
    [update]
  )

  const handlePresetSelect = useCallback(
    (preset: ThemeConfig) => setTheme(preset),
    [setTheme]
  )

  const handleAccentChange = useCallback(
    (h: number, s: number) => update({ accent: { h, s, l: current.accent.l } }),
    [current.accent.l, update]
  )

  const handleRadiusChange = useCallback(
    (radiusScale: number) => update({ radiusScale }),
    [update]
  )

  const handleGlassToggle = useCallback(
    (enableGlass: boolean) => update({ enableGlass }),
    [update]
  )

  const handleFontScaleChange = useCallback(
    (fontScale: number) => update({ fontScale }),
    [update]
  )

  const handleBaseColorsChange = useCallback(
    (baseColors: BaseColors) => update({ baseColors }),
    [update]
  )

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Mode</h4>
        <ModeSelector value={current.mode} onChange={handleModeChange} />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Presets</h4>
        <PresetGrid activeId={current.id} onSelect={handlePresetSelect} />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Accent Color</h4>
        <AccentPicker
          hue={current.accent.h}
          saturation={current.accent.s}
          onChange={handleAccentChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Base Colors</h4>
        <BaseColorPicker
          baseColors={current.baseColors ?? {}}
          onChange={handleBaseColorsChange}
        />
      </section>

      <section className={styles.section}>
        <h4 className={styles.sectionLabel}>Controls</h4>
        <DepthControls
          radiusScale={current.radiusScale}
          enableGlass={current.enableGlass}
          fontScale={current.fontScale}
          onRadiusChange={handleRadiusChange}
          onGlassToggle={handleGlassToggle}
          onFontScaleChange={handleFontScaleChange}
        />
      </section>

      <button
        type="button"
        className={styles.resetBtn}
        onClick={() => setTheme(null)}
      >
        Reset to Default
      </button>
    </div>
  )
}
