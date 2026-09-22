/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { generateThemeVariables } from './engine'
import { DEFAULT_THEME } from './presets'
import GENERATED_VARS from '../lib/generatedCssVariables'

describe('generateThemeVariables', () => {
  test('derives a dark accent control surface and a readable glyph in both modes', () => {
    const dark = generateThemeVariables(DEFAULT_THEME, 'dark')
    const light = generateThemeVariables(DEFAULT_THEME, 'light')

    for (const vars of [dark, light]) {
      const channels = vars['--lumiverse-primary-deep']
        .match(/\d+/g)
        ?.map(Number)

      expect(channels).toHaveLength(3)
      expect(Math.max(...(channels ?? [255]))).toBeLessThan(64)
      expect(vars['--lumiverse-primary-deep-contrast']).toMatch(/95%\)$/)
    }

    expect(dark['--lumiverse-primary-deep']).not.toBe(light['--lumiverse-primary-deep'])
  })

  test('allows a dynamic theme to keep its deep surface separate from its app background', () => {
    const vars = generateThemeVariables({
      ...DEFAULT_THEME,
      baseColors: {
        background: 'rgb(32 42 52)',
        backgroundDeep: 'rgb(9 12 15)',
      },
    }, 'dark')

    expect(vars['--lumiverse-bg']).toBe('rgb(32 42 52)')
    expect(vars['--lumiverse-bg-deep']).toBe('rgb(9 12 15)')
  })

  test('keeps semantic material aliases synchronized after theme overrides resolve', () => {
    const vars = generateThemeVariables({
      ...DEFAULT_THEME,
      baseColors: {
        primary: '#4f46e5',
        background: 'rgb(32 42 52)',
        text: '#e8ecf4',
      },
    }, 'dark')

    expect(vars['--lumiverse-surface']).toBe(vars['--lumiverse-bg'])
    expect(vars['--lumiverse-surface-raised']).toBe(vars['--lumiverse-bg-elevated'])
    expect(vars['--lumiverse-surface-hover']).toBe(vars['--lumiverse-bg-hover'])
    expect(vars['--lumiverse-surface-muted']).toBe(vars['--lumiverse-fill-subtle'])
    expect(vars['--lumiverse-input-bg']).toBe(vars['--lumiverse-fill'])
    expect(vars['--lumiverse-border-subtle']).toBe(vars['--lumiverse-border-light'])
    expect(vars['--lumiverse-primary-soft']).toBe(vars['--lumiverse-primary-015'])
    expect(vars['--lumiverse-text-primary']).toBe(vars['--lumiverse-text'])
    expect(vars['--lumiverse-text-secondary']).toBe(vars['--lumiverse-text-muted'])
  })

  test('ships semantic material and Chat Shell variables in the public variable reference', () => {
    expect(GENERATED_VARS['--lumiverse-surface']).toBe('var(--lumiverse-bg)')
    expect(GENERATED_VARS['--lumiverse-surface-raised']).toBe('var(--lumiverse-bg-elevated)')
    expect(GENERATED_VARS['--lumiverse-input-bg']).toBe('var(--lumiverse-fill)')
    expect(GENERATED_VARS['--lumiverse-border-subtle']).toBe('var(--lumiverse-border-light)')
    expect(GENERATED_VARS['--lcs-glass-bg']).toBeDefined()
    expect(GENERATED_VARS['--lcs-glass-bg-hover']).toBeDefined()
    expect(GENERATED_VARS['--lcs-glass-border-hover']).toBeDefined()
  })
})
