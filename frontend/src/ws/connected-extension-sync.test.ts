import { describe, expect, test } from 'bun:test'
import { shouldSyncExtensionsAfterConnected } from './connected-extension-sync'

describe('CONNECTED extension sync', () => {
  test('ignores the local socket-open emission and syncs only after server authentication', () => {
    expect([
      undefined,
      {},
      { role: 'owner' },
    ].filter(shouldSyncExtensionsAfterConnected)).toEqual([{ role: 'owner' }])
  })
})
