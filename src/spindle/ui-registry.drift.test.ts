import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILT_IN_DRAWER_TABS, BUILT_IN_SETTINGS_TABS } from './ui-registry'

function frontendIds(source: string): string[] {
  return [...source.matchAll(/^\s+id:\s*'([^']+)'/gm)].map((match) => match[1])
}

describe('frontend/backend H4 registry mirror', () => {
  test('built-in drawer ids stay in sync', async () => {
    const source = await readFile(join(import.meta.dir, '../../frontend/src/lib/drawer-tab-registry.tsx'), 'utf8')
    expect(BUILT_IN_DRAWER_TABS.map((tab) => tab.id)).toEqual(frontendIds(source))
  })

  test('built-in settings ids stay in sync', async () => {
    const source = await readFile(join(import.meta.dir, '../../frontend/src/lib/settings-tab-registry.tsx'), 'utf8')
    expect(BUILT_IN_SETTINGS_TABS.map((tab) => tab.id)).toEqual(frontendIds(source))
  })
})
