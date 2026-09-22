import { afterAll, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true })
const state = { user: { id: 'account' }, activeChatWallpaper: null,
  wallpaper: { global: null, opacity: 0.4, fit: 'cover', blur: 0 }, useCharacterBackground: false,
  sceneBackground: null, imageGeneration: {}, characters: [] }
mock.module('@/store', () => ({ useStore: Object.assign((select: (value: unknown) => unknown) => select(state), { getState: () => state }) }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }))
const { default: ActiveTabGuard } = await import('./ActiveTabGuard')
const root = createRoot(document.getElementById('root')!)
afterAll(async () => { await act(async () => root.unmount()); dom.window.close() })

async function renderWith(storage: unknown) {
  Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: storage })
  await act(async () => {
    root.render(<StrictMode><ActiveTabGuard><button>Generate</button></ActiveTabGuard></StrictMode>)
  })
}

test('renders when localStorage access itself is disabled', async () => {
  Object.defineProperty(dom.window, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: storage disabled') },
  })
  await act(async () => {
    root.render(<StrictMode><ActiveTabGuard><button>Generate</button></ActiveTabGuard></StrictMode>)
  })
  expect(document.body.textContent).toContain('Generate')
})

test('renders when storage writes throw', async () => {
  await renderWith({
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError') },
    removeItem: () => {},
  })
  expect(document.body.textContent).toContain('Generate')
})

test('renders when storage silently drops writes', async () => {
  const map = new Map<string, string>()
  await renderWith({
    getItem: (key: string) => map.get(key) ?? null,
    // A partitioned/embedded webview can accept a write and never persist it.
    setItem: () => {},
    removeItem: (key: string) => { map.delete(key) },
  })
  expect(document.body.textContent).toContain('Generate')
})
