/// <reference types="bun-types" />

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const getLoginUrl = mock(async () => ({ url: 'https://identity.example/authorize' }))

mock.module('@/api/sso-providers', () => ({
  ssoProvidersApi: {
    getLoginUrl,
    getLinkUrl: getLoginUrl,
  },
}))

const dom = new JSDOM('', { url: 'https://lumiverse.example/login' })
const previousWindow = globalThis.window
const previousCrypto = globalThis.crypto
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
Object.defineProperty(dom.window.crypto, 'randomUUID', { configurable: true, value: () => FLOW_ID })
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: dom.window.crypto })

const { startSsoPopup } = await import('./ssoPopup')

beforeEach(() => {
  getLoginUrl.mockClear()
})

afterAll(() => {
  dom.window.close()
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: previousCrypto })
  mock.restore()
})

test('closes the opened window after a successful SSO completion', async () => {
  let closeCalls = 0
  const popup = {
    closed: false,
    close: () => { closeCalls += 1 },
    focus: () => undefined,
    location: { href: 'about:blank' },
  }
  Object.defineProperty(dom.window, 'open', {
    configurable: true,
    value: () => popup,
  })

  const resultPromise = startSsoPopup({ providerId: 'example', flow: 'login' })
  await Promise.resolve()

  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    origin: dom.window.location.origin,
    data: {
      type: 'lumiverse:sso-complete',
      payload: {
        flow: 'login',
        providerId: 'example',
        flowId: FLOW_ID,
        ok: true,
      },
    },
  }))

  await expect(resultPromise).resolves.toMatchObject({ ok: true, flowId: FLOW_ID })
  expect(closeCalls).toBe(1)
})
