import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import common from '../../i18n/locales/en/common.json'
import panels from '../../i18n/locales/en/panels.json'
import shared from '../../i18n/locales/en/shared.json'
import type { RegexScript } from '@/types/regex'

let createRoot: typeof CreateRoot
let RegexPanel: () => ReactNode
let resetRegexEvidenceForTests: () => void

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  CustomEvent: domWindow.CustomEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

if (!domWindow.PointerEvent) {
  class TestPointerEvent extends domWindow.MouseEvent {}
  Object.assign(domWindow, { PointerEvent: TestPointerEvent })
  Object.assign(globalThis, { PointerEvent: TestPointerEvent })
}

if (!globalThis.ResizeObserver) {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
}

if (!domWindow.HTMLElement.prototype.scrollIntoView) {
  domWindow.HTMLElement.prototype.scrollIntoView = () => {}
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const evidenceReports: Array<{ id: string; payload: Record<string, unknown> }> = []
let reportEvidenceImpl: (id: string, payload: Record<string, unknown>) => Promise<unknown> = async () => ({})
const successToasts: string[] = []
const errorToasts: string[] = []
let storedRegexFolders: string[] = []
const putSetting = jest.fn(async (key: string, value: unknown) => {
  if (key === 'regexScriptFolders' && Array.isArray(value)) {
    storedRegexFolders = value as string[]
  }
})

mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: (id: string, payload: Record<string, unknown>) => {
      evidenceReports.push({ id, payload })
      return reportEvidenceImpl(id, payload)
    },
    list: async () => ({ data: [], total: 0, limit: 1000, offset: 0 }),
    reportPerformance: async () => ({}),
  },
}))
mock.module('@/api/settings', () => ({
  settingsApi: {
    get: async (key: string) => ({ value: key === 'regexScriptFolders' ? storedRegexFolders : [] }),
    put: putSetting,
  },
}))
mock.module('@/lib/toast', () => ({
  toast: {
    success: (message: string) => successToasts.push(message),
    error: (message: string) => errorToasts.push(message),
    warning: () => {},
    info: () => {},
  },
}))

const loadRegexScripts = jest.fn(async () => {})
const updateRegexScript = jest.fn(async () => {})

let storeState: Record<string, unknown> = {}

function baseStoreState(scripts: RegexScript[]): Record<string, unknown> {
  return {
    regexScripts: scripts,
    loadRegexScripts,
    addRegexScript: jest.fn(async () => scripts[0]),
    updateRegexScript,
    removeRegexScript: jest.fn(async () => {}),
    bulkRemoveRegexScripts: jest.fn(async () => 0),
    toggleRegexScript: jest.fn(async () => {}),
    toggleSelectedRegexScripts: jest.fn(async () => ({ changedIds: [], skippedIds: [] })),
    toggleRegexFolder: jest.fn(async () => ({ changedIds: [], skippedIds: [] })),
    reorderRegexScripts: jest.fn(async () => {}),
    openModal: jest.fn(),
    activeCharacterId: null,
    activeChatId: null,
    activeLoomPresetId: null,
    presets: {},
  }
}

mock.module('@/store', () => ({
  useStore: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => (selector ? selector(storeState) : storeState),
    {
      getState: () => storeState,
      setState: (patch: Record<string, unknown>) => Object.assign(storeState, patch),
      subscribe: () => () => {},
    },
  ),
}))

const englishI18n = createInstance()
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

// The app-level i18n module eagerly resolves locale bundles through
// `import.meta.glob`, which Bun's test runtime does not implement. Delegate the
// imperative `i18n.t` calls in the panel to the instance this test controls.
mock.module('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => englishI18n.t(key, options),
    language: 'en',
    on: () => {},
    off: () => {},
  },
  initI18n: async () => {},
  ensureLanguageLoaded: async () => {},
  changeUiLanguage: async () => {},
  UI_LANGUAGE_STORAGE_KEY: 'ui-language',
}))

function script(id: string, overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id, user_id: 'user', name: id, script_id: id, find_regex: 'x', replace_string: 'y',
    actions: [], flags: 'g', placement: ['ai_output'], scope: 'global', scope_id: null,
    target: ['display'], min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false,
    substitute_macros: 'none', disabled: false, sort_order: 0, description: '', folder: '', metadata: {},
    created_at: 1, updated_at: 1, ...overrides,
  }
}

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })

  await act(async () => {
    root.render(<I18nextProvider i18n={englishI18n}>{node}</I18nextProvider>)
    await Promise.resolve()
  })

  return host
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function byAriaLabel(host: HTMLElement, label: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}

const QUARANTINE_DETAIL = panels.regexPanel.quarantinedDetail
const CLEAR_ARIA = 'Clear the quarantine on hung-script and run it again'

beforeAll(async () => {
  await englishI18n.use(initReactI18next).init({
    resources: { en: { panels, shared, common } },
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'panels',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

  // dnd-kit and ReactDOM must evaluate after JSDOM installs browser globals.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ resetRegexEvidenceForTests } = await import('@/lib/regex/evidence'))
  ;({ default: RegexPanel } = await import('./RegexPanel'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()
  resetRegexEvidenceForTests()
  evidenceReports.length = 0
  successToasts.length = 0
  errorToasts.length = 0
  storedRegexFolders = []
  putSetting.mockClear()
  reportEvidenceImpl = async () => ({})
  loadRegexScripts.mockClear()
  updateRegexScript.mockClear()
})

describe('RegexPanel quarantine recovery', () => {
  test('a quarantined script exposes a labelled badge and a clear control that persists quarantined:false', async () => {
    const hung = script('hung-script', { metadata: { regex_evidence: { quarantined: true } } })
    storeState = baseStoreState([hung])

    const host = await mount(<RegexPanel />)

    // Collapsed row: the badge is announced, not colour-only.
    const badge = byAriaLabel(host, QUARANTINE_DETAIL)
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('title')).toBe(QUARANTINE_DETAIL)
    expect(badge?.textContent).toContain(panels.regexPanel.quarantined)

    // Expanding the row surfaces the recovery control.
    expect(byAriaLabel(host, CLEAR_ARIA)).toBeNull()
    await click(badge!)

    const clearButton = byAriaLabel(host, CLEAR_ARIA) as HTMLButtonElement | null
    expect(clearButton).not.toBeNull()
    expect(clearButton?.tagName).toBe('BUTTON')
    expect(clearButton?.textContent).toContain(panels.regexPanel.clearQuarantine)
    expect(host.textContent).toContain(QUARANTINE_DETAIL)

    await click(clearButton!)

    expect(evidenceReports).toEqual([{ id: 'hung-script', payload: { quarantined: false } }])
    expect(loadRegexScripts).toHaveBeenCalledTimes(2) // mount effect + post-clear refetch
    expect(successToasts).toEqual(['"hung-script" is no longer quarantined and will run again.'])
    expect(errorToasts).toEqual([])
    // No write was issued to clear it: the evidence endpoint owns the flag.
    expect(updateRegexScript).not.toHaveBeenCalled()

    // The overlay is authoritative, so the affordance disappears even though the
    // store row still carries the stale metadata until the refetch lands.
    expect(byAriaLabel(host, CLEAR_ARIA)).toBeNull()
    expect(byAriaLabel(host, QUARANTINE_DETAIL)).toBeNull()
  })

  test('a script that is not quarantined renders neither the badge nor the clear control', async () => {
    storeState = baseStoreState([script('healthy-script')])

    const host = await mount(<RegexPanel />)

    expect(byAriaLabel(host, QUARANTINE_DETAIL)).toBeNull()
    expect(host.textContent).not.toContain(QUARANTINE_DETAIL)
    expect(evidenceReports).toEqual([])
  })

  test('a failed clear surfaces the server error and leaves the panel usable', async () => {
    const hung = script('hung-script', { metadata: { regex_evidence: { quarantined: true } } })
    storeState = baseStoreState([hung])
    reportEvidenceImpl = async () => {
      throw Object.assign(new Error('request failed'), { body: { error: 'Script is read-only' } })
    }

    const host = await mount(<RegexPanel />)
    await click(byAriaLabel(host, QUARANTINE_DETAIL)!)
    await click(byAriaLabel(host, CLEAR_ARIA)!)

    expect(evidenceReports).toEqual([{ id: 'hung-script', payload: { quarantined: false } }])
    expect(errorToasts).toEqual(['Script is read-only'])
    expect(successToasts).toEqual([])
  })
})

describe('RegexPanel folders', () => {
  test('scoped views omit folders that contain no matching scripts', async () => {
    storedRegexFolders = ['Empty folder']
    storeState = {
      ...baseStoreState([
        script('global-script', { folder: 'Global folder' }),
        script('matching-chat-script', { folder: 'Matching chat folder', scope: 'chat', scope_id: 'chat-1' }),
        script('other-chat-script', { folder: 'Other chat folder', scope: 'chat', scope_id: 'chat-2' }),
      ]),
      activeChatId: 'chat-1',
    }

    const host = await mount(<RegexPanel />)

    expect(host.textContent).toContain('Empty folder')
    expect(host.textContent).toContain('Global folder')
    expect(host.textContent).toContain('Matching chat folder')
    expect(host.textContent).toContain('Other chat folder')

    const chatScopeButton = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === panels.regexPanel.scopeThisChat)
    expect(chatScopeButton).not.toBeUndefined()
    await click(chatScopeButton!)

    expect(host.textContent).toContain('Matching chat folder')
    expect(host.textContent).not.toContain('Empty folder')
    expect(host.textContent).not.toContain('Global folder')
    expect(host.textContent).not.toContain('Other chat folder')
  })

  test('creating a folder with no scripts renders a blank folder target', async () => {
    storeState = baseStoreState([])
    const host = await mount(<RegexPanel />)

    expect(host.textContent).toContain(panels.regexPanel.noScripts)

    await click(host.querySelector<HTMLElement>('button[title="Add"]')!)
    const newFolderButton = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(panels.regexPanel.newFolder))
    expect(newFolderButton).not.toBeUndefined()
    await click(newFolderButton!)

    const folderInput = host.querySelector<HTMLInputElement>(`input[placeholder="${panels.regexPanel.folderName}"]`)
    expect(folderInput).not.toBeNull()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')?.set
      setValue?.call(folderInput, 'Post-processing')
      folderInput!.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      folderInput!.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    expect(host.textContent).toContain('Post-processing')
    expect(host.textContent).not.toContain(panels.regexPanel.noScripts)
    expect(host.querySelector('[role="button"]')?.textContent).toContain('Post-processing0')
  })

  test('renders a previously persisted folder when the regex library is empty', async () => {
    storedRegexFolders = ['Reusable targets']
    storeState = baseStoreState([])

    const host = await mount(<RegexPanel />)

    expect(host.textContent).toContain('Reusable targets')
    expect(host.textContent).not.toContain(panels.regexPanel.noScripts)
  })

  test('deletes a persisted empty folder after confirmation', async () => {
    storedRegexFolders = ['Reusable targets']
    storeState = baseStoreState([])

    const host = await mount(<RegexPanel />)
    await click(byAriaLabel(host, 'Delete all scripts in Reusable targets')!)
    await click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!)

    expect(host.textContent).not.toContain('Reusable targets')
    expect(host.textContent).toContain(panels.regexPanel.noScripts)
  })

  test('removes a populated folder from settings after all scripts are deleted', async () => {
    storedRegexFolders = ['Reusable targets']
    const folderScript = script('folder-script', { folder: 'Reusable targets' })
    const bulkRemoveRegexScripts = jest.fn(async () => 1)
    storeState = {
      ...baseStoreState([folderScript]),
      bulkRemoveRegexScripts,
    }

    const host = await mount(<RegexPanel />)
    await click(byAriaLabel(host, 'Delete all scripts in Reusable targets')!)
    await click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!)

    expect(bulkRemoveRegexScripts).toHaveBeenCalledWith(['folder-script'])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(storedRegexFolders).toEqual([])
  })

  test('keeps a populated folder in settings when some scripts cannot be deleted', async () => {
    storedRegexFolders = ['Reusable targets']
    const scripts = [
      script('deletable-script', { folder: 'Reusable targets' }),
      script('protected-script', { folder: 'Reusable targets' }),
    ]
    const bulkRemoveRegexScripts = jest.fn(async () => 1)
    storeState = {
      ...baseStoreState(scripts),
      bulkRemoveRegexScripts,
    }

    const host = await mount(<RegexPanel />)
    await click(byAriaLabel(host, 'Delete all scripts in Reusable targets')!)
    await click(document.querySelector<HTMLButtonElement>('button[type="submit"]')!)

    expect(bulkRemoveRegexScripts).toHaveBeenCalledWith(['deletable-script', 'protected-script'])
    expect(storedRegexFolders).toEqual(['Reusable targets'])
    expect(errorToasts).toEqual(['1 scripts could not be deleted'])
  })
})
