import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const startImport = mock(async () => ({ jobId: 'restore-job' }))
const getImportStatus = mock()
const skipTicket = mock(async () => ({}))
const refresh = mock(async () => {})
const t = (key: string) => key
mock.module('react-i18next', () => ({ useTranslation: () => ({ t }) }))
mock.module('@/ws/client', () => ({ wsClient: { on: () => () => {} } }))
mock.module('@/api/user-data', () => ({ userDataApi: { startImport, getImportStatus, skipTicket } }))
mock.module('@/hooks/useAppInit', () => ({ refreshAppDataAfterImport: refresh }))
mock.module('@/store/slices/settings', () => ({ flushSettingsNow: async () => {} }))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
}))
const { default: DataPortability } = await import('./DataPortability')
let dom: JSDOM
let root: Root
let host: HTMLDivElement
let previous: Record<string, unknown>
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Reflect.get(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  jest.useFakeTimers()
  startImport.mockClear()
  skipTicket.mockClear()
  refresh.mockClear()
  getImportStatus.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  jest.useRealTimers()
  dom.window.close()
  for (const [key, value] of Object.entries(previous)) Reflect.set(globalThis, key, value)
})
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent === label)
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}
async function start() {
  await act(async () => { root.render(<DataPortability />) })
  const input = host.querySelector('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['zip'], 'backup.lvbak')] })
  await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
  await click('dataPortability.uploadImport')
}
async function tick() {
  await act(async () => { jest.advanceTimersByTime(1000) })
}
const status = (state: string) => ({ jobId: 'restore-job', status: state, summary: { characters: { imported: 1, skipped: 0 } }, fileSummary: {}, manifest: { secretsCount: 1 } })

test('polls beyond the old one-shot delay and refreshes imported data without WebSocket events', async () => {
  getImportStatus.mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(status('running')).mockResolvedValueOnce(status('running')).mockResolvedValue(status('complete'))
  await start()
  await tick(); await tick(); await tick()
  expect(refresh).not.toHaveBeenCalled()
  await tick()
  expect(refresh).toHaveBeenCalledWith('restore-job')
  expect(host.textContent).toContain('dataPortability.importComplete')
  await tick()
  expect(getImportStatus).toHaveBeenCalledTimes(4)
})

test('recovers the ticket prompt and completion through polling alone', async () => {
  getImportStatus.mockResolvedValueOnce(status('awaiting_ticket')).mockResolvedValue(status('complete'))
  await start()
  await tick()
  await click('dataPortability.skipApiKeys')
  expect(skipTicket).toHaveBeenCalledWith('restore-job')
  await tick()
  expect(refresh).toHaveBeenCalledWith('restore-job')
  expect(host.textContent).not.toContain('dataPortability.ticketPrompt')
})
