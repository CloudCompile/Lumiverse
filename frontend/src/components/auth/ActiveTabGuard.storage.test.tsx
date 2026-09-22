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

test('the application still renders when browser storage rejects the ownership claim', async () => {
  Object.defineProperty(dom.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => {},
    },
  })
  await act(async () => {
    root.render(<StrictMode><ActiveTabGuard><button>Generate</button></ActiveTabGuard></StrictMode>)
  })
  expect(document.body.textContent).toContain('Generate')
})
