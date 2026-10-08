import { afterAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { registerLiveRoot } from './live-root-registry'
import { setWidgetTouchScrollMode, usesNativeWidgetTouchScroll } from './widget-touch-scroll'

const dom = new JSDOM('<body></body>')
const originals = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element }
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element })
afterAll(() => { Object.assign(globalThis, originals); dom.window.close() })
beforeEach(() => document.body.replaceChildren())

// Exercise the real document guard without booting the router/service worker.
const main = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8')
const start = main.indexOf('if ((window.navigator as any).standalone === true && navigator.maxTouchPoints > 0) {', main.indexOf('// Two WebKit bugs'))
const end = main.indexOf('// ── Mobile layout recovery', start)
if (start < 0 || end < start) throw new Error('Installed-iOS guard fixture anchors changed')
const code = ts.transpile(main.slice(start, end), { target: ts.ScriptTarget.ESNext })
Object.defineProperty(window.navigator, 'standalone', { value: true })
Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 1 })
const install = new Function('window', 'document', 'navigator', 'findScrollableAncestor', 'usesNativeWidgetTouchScroll', 'installKeyboardFocusReveal', code)
install(window, document, window.navigator, () => null, usesNativeWidgetTouchScroll, () => {})

function touch(target: Element, type = 'touchmove', count = 1): Event {
  const event = new dom.window.Event(type, { bubbles: true, composed: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientX: 10, clientY: 30 })) })
  target.dispatchEvent(event)
  return event
}

test('real installed-iOS document guard is unchanged for core and other widgets', () => {
  const core = document.createElement('div'), native = document.createElement('div'), other = document.createElement('div')
  document.body.append(core, native, other)
  const offNative = registerLiveRoot('native', native, 'ui_panels', 1)
  const offOther = registerLiveRoot('other', other, 'ui_panels', 1)
  try {
    expect(touch(core).defaultPrevented).toBe(true)
    expect(touch(native).defaultPrevented).toBe(true)
    setWidgetTouchScrollMode(native, 'native')
    expect(touch(native).defaultPrevented).toBe(false)
    expect(touch(other).defaultPrevented).toBe(true)
    expect(touch(core).defaultPrevented).toBe(true)
    setWidgetTouchScrollMode(native, 'guarded')
    expect(touch(native).defaultPrevented).toBe(true)
  } finally { offNative(); offOther() }
})

test('nearest registered placement isolates nested widgets, including shadow content', () => {
  const root = document.createElement('div'), nested = document.createElement('div')
  root.append(nested); document.body.append(root)
  const off = registerLiveRoot('native', root, 'ui_panels', 1)
  const offNested = registerLiveRoot('other', nested, 'ui_panels', 1)
  const shadow = root.attachShadow({ mode: 'open' }), child = document.createElement('button')
  shadow.append(child)
  try {
    setWidgetTouchScrollMode(root, 'native')
    expect(touch(child).defaultPrevented).toBe(false)
    expect(touch(nested).defaultPrevented).toBe(true)
  } finally { off(); offNested() }
})

test('detached, unregistered, forged and reused roots do not retain native policy', () => {
  const root = document.createElement('div')
  root.dataset.spindleExtensionRoot = 'native'
  document.body.append(root)
  expect(touch(root).defaultPrevented).toBe(true)
  const off = registerLiveRoot('native', root, 'ui_panels', 1)
  setWidgetTouchScrollMode(root, 'native')
  root.remove()
  expect(usesNativeWidgetTouchScroll({ composedPath: () => [root] } as unknown as Event)).toBe(false)
  document.body.append(root)
  off()
  expect(touch(root).defaultPrevented).toBe(true)
  const offNew = registerLiveRoot('native', root, 'ui_panels', 2)
  try { expect(touch(root).defaultPrevented).toBe(true) } finally { offNew() }
})

test('single-finger override does not change the guard multi-touch path', () => {
  const root = document.createElement('div'); document.body.append(root)
  const off = registerLiveRoot('native', root, 'ui_panels', 1)
  try {
    // This document guard already ignores multiple touches in both modes.
    expect(touch(root, 'touchmove', 2).defaultPrevented).toBe(false)
    setWidgetTouchScrollMode(root, 'native')
    expect(touch(root, 'touchmove', 2).defaultPrevented).toBe(false)
  } finally { off() }
})
