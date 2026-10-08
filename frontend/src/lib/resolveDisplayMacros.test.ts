/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { resolveDisplayMacros, stripDisplaySetterMacros } from './resolveDisplayMacros'

describe('resolveDisplayMacros', () => {
  test('strips setter macros from displayed bubble content', () => {
    expect(stripDisplaySetterMacros('Before {{setvar::scene::alley}} after')).toBe('Before  after')
    expect(resolveDisplayMacros('Mood {{setchatvar::mood::calm}} for {{user}}', {
      charName: 'Assistant',
      userName: 'User',
    })).toBe('Mood  for User')
  })

  test('leaves valid <json> blocks untouched', () => {
    const ctx = { charName: 'Assistant', userName: 'User' }
    const block = '<json>{"who": "{{user}}", "legacy": "<USER>", "set": "{{setvar::x::y}}"}</json>'
    expect(resolveDisplayMacros(`{{user}} <BOT> ${block}{{setvar::a::b}}`, ctx)).toBe(`User Assistant ${block}`)
    expect(stripDisplaySetterMacros(`${block}{{setvar::a::b}}`)).toBe(block)
    // Not JSON, so its macros resolve as usual.
    expect(resolveDisplayMacros('<json>{{user}}</json>', ctx)).toBe('<json>User</json>')
  })
})
