import { describe, expect, test } from 'bun:test'
import {
  filterEnabledFrontendContributions,
  hasEnabledFrontendExtension,
  hasEnabledFrontendExtensionId,
} from './frontend-extension-availability'

describe('frontend extension availability', () => {
  test('requires an installed, enabled frontend extension with the requested identifier', () => {
    const hasSuite = (extensions: Parameters<typeof hasEnabledFrontendExtension>[0]) => (
      hasEnabledFrontendExtension(extensions, 'lumiverse_suite')
    )

    expect(hasSuite(undefined)).toBe(false)
    expect(hasSuite([])).toBe(false)
    expect(hasSuite([{ identifier: 'another_extension', enabled: true, has_frontend: true }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: false, has_frontend: true }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: true, has_frontend: false }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: true, has_frontend: true }])).toBe(true)
  })

  test('requires the owning extension id for registered frontend contributions', () => {
    const extensions = [
      { id: 'suite', enabled: false, has_frontend: true },
      { id: 'backend-only', enabled: true, has_frontend: false },
      { id: 'active', enabled: true, has_frontend: true },
    ]

    expect(hasEnabledFrontendExtensionId(extensions, 'suite')).toBe(false)
    expect(hasEnabledFrontendExtensionId(extensions, 'backend-only')).toBe(false)
    expect(hasEnabledFrontendExtensionId(extensions, 'active')).toBe(true)
    expect(filterEnabledFrontendContributions([
      { id: 'suite-widget', extensionId: 'suite' },
      { id: 'active-widget', extensionId: 'active' },
    ], extensions)).toEqual([{ id: 'active-widget', extensionId: 'active' }])
  })
})
