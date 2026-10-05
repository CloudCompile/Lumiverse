import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SPINDLE_MODAL_MAX_HEIGHT,
  DEFAULT_SPINDLE_MODAL_WIDTH,
  resolveSpindleModalGeometry,
} from './modal-geometry'

describe('Spindle modal geometry', () => {
  test('clamps large modals in layout space instead of shrinking the viewport twice', () => {
    const full = resolveSpindleModalGeometry(
      { width: 1200, maxHeight: 900 },
      { width: 690, height: 1500, uiScale: 1 },
    )
    const compact = resolveSpindleModalGeometry(
      { width: 1200, maxHeight: 900 },
      { width: 690, height: 1500, uiScale: 0.7 },
    )

    expect(full.width).toBe(650)
    expect(compact.width).toBeCloseTo(945.7142857)
    expect(compact.width * 0.7).toBeCloseTo(662)
    expect(compact.maxHeight).toBe(900)
  })

  test('keeps ordinary requested sizes in logical UI-scale space', () => {
    const geometry = resolveSpindleModalGeometry(
      { width: 420, maxHeight: 520 },
      { width: 1200, height: 800, uiScale: 0.7 },
    )

    expect(geometry).toEqual({ width: 420, maxHeight: 520 })
  })

  test('uses the scaled viewport height so keyboard-constrained modals still fit', () => {
    const geometry = resolveSpindleModalGeometry(
      { width: 1200, maxHeight: 900 },
      { width: 690, height: 480, uiScale: 1.5 },
    )

    expect(geometry.width).toBe(420)
    expect(geometry.maxHeight).toBe(280)
    expect(geometry.maxHeight * 1.5).toBe(420)
  })

  test('falls back safely for missing or invalid requested dimensions and scale', () => {
    const geometry = resolveSpindleModalGeometry(
      { width: Number.NaN, maxHeight: -1 },
      { width: 1200, height: 800, uiScale: 0 },
    )

    expect(geometry).toEqual({
      width: DEFAULT_SPINDLE_MODAL_WIDTH,
      maxHeight: DEFAULT_SPINDLE_MODAL_MAX_HEIGHT,
    })
  })
})
