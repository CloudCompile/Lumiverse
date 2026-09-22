import { describe, expect, test } from 'bun:test'
import { createFrontendExtensionContext } from './frontend-context'
import type { FrontendDomainAPI } from './frontend-domain-api'

describe('frontend context composition', () => {
  test('preserves host members while composing the H2/H10 roots', () => {
    const domain = {
      connections: { list: () => [], getActive: () => null, subscribe: () => () => {}, models: async () => ({}), setActive: () => {}, update: async () => ({}) },
      chats: { listForCharacter: async () => [], getMessages: async () => ({ data: [] }) },
      worldBooks: { list: async () => [], entries: async () => [] },
      messages: { getContent: () => null, getRecent: () => [] },
      tokens: { countText: async () => ({}), countMessages: async () => ({}), countChat: async () => ({}), countTextBatch: async () => ({}) },
      dispose: () => {},
    } as unknown as FrontendDomainAPI
    const state = { get: () => null, subscribe: () => () => {}, list: () => [], revokePermissions: () => {}, dispose: () => {} }
    const context = createFrontendExtensionContext({
      base: {
        marker: 'host',
        chats: { updateMessage: () => 'existing' },
        messages: { listMessageIds: () => ['message-1'] },
      },
      state,
      domain,
      onTeardown: () => () => {},
    })

    expect(context.marker).toBe('host')
    expect(context.chats.updateMessage()).toBe('existing')
    expect(context.chats.listForCharacter).toBe(domain.chats.listForCharacter)
    expect(context.messages.listMessageIds()).toEqual(['message-1'])
    expect(context.state).toBe(state)
    expect(context.worldBooks).toBe(domain.worldBooks)
    expect(context.tokens).toBe(domain.tokens)
  })
})
