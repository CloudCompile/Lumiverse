import { describe, expect, test } from 'bun:test'
import { formatValue, previewValue } from './format'

describe('formatValue', () => {
  test('renders plain strings unchanged', () => {
    expect(formatValue('A courier.')).toBe('A courier.')
  })

  test('numbers list fields so entries are distinguishable', () => {
    expect(formatValue(['sci-fi', 'courier'])).toBe('1. sci-fi\n2. courier')
  })

  test('marks empty and blank values instead of rendering nothing', () => {
    expect(formatValue(undefined)).toBe('(empty)')
    expect(formatValue(null)).toBe('(empty)')
    expect(formatValue('   ')).toBe('(empty)')
    expect(formatValue([])).toBe('(empty list)')
  })
})

describe('previewValue', () => {
  test('collapses whitespace and truncates long values', () => {
    expect(previewValue('a\n\n  b')).toBe('a b')
    expect(previewValue('x'.repeat(200), 20)).toBe(`${'x'.repeat(20)}…`)
  })

  test('leaves short values intact', () => {
    expect(previewValue('short')).toBe('short')
  })
})
