/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { toOpaqueRgb, withPreservedAlpha } from '../theme/themeColor'

describe('toOpaqueRgb', () => {
  test('converts character-aware CSS Color 4 RGB values for native PWA chrome', () => {
    expect(toOpaqueRgb('rgb(18 14 22)')).toBe('rgb(18, 14, 22)')
  })

  test('supports slash alpha in space-separated RGB values', () => {
    expect(toOpaqueRgb('rgb(18 14 22 / 50%)')).toBe('rgb(9, 7, 11)')
  })

  test('keeps supporting legacy comma-separated RGBA values', () => {
    expect(toOpaqueRgb('rgba(18, 14, 22, 0.5)')).toBe('rgb(9, 7, 11)')
  })

  test('keeps supporting the HSL values emitted by built-in themes', () => {
    expect(toOpaqueRgb('hsla(0, 0%, 50%, 0.5)')).toBe('rgb(64, 64, 64)')
  })
})

describe('withPreservedAlpha', () => {
  test('uses the live palette color while retaining the configured tint opacity', () => {
    expect(withPreservedAlpha('rgb(18 14 22)', 'rgb(16 12 28 / 72%)'))
      .toBe('rgb(18 14 22 / 0.72)')
  })

  test('returns no recolor when the saved tint is not parseable', () => {
    expect(withPreservedAlpha('rgb(18 14 22)', 'not-a-color')).toBeNull()
  })
})
