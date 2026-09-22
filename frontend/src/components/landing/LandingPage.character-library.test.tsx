import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, forwardRef, useSyncExternalStore, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import landing from '../../i18n/locales/en/landing.json'
import panels from '../../i18n/locales/en/panels.json'
import common from '../../i18n/locales/en/shared.json'
import {
  clearLandingPageSnapshot,
  markLandingPageChatReturn,
  writeLandingPageSnapshot,
} from '@/lib/landingPageSnapshot'

let createRoot: typeof CreateRoot
let LandingPage: () => ReactNode

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const syncRequestAnimationFrame = (callback: FrameRequestCallback) => {
  callback(0)
  return 0
}
const syncCancelAnimationFrame = (_handle: number) => {}
Object.assign(domWindow, {
  requestAnimationFrame: syncRequestAnimationFrame,
  cancelAnimationFrame: syncCancelAnimationFrame,
})

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
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  DOMRect: domWindow.DOMRect,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  localStorage: domWindow.localStorage,
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

type Summary = {
  id: string
  name: string
  creator: string
  folder: string
  tags: string[]
  image_id: string | null
  created_at: number
  updated_at: number
  has_alternate_greetings: boolean
  library_scope: 'mine' | 'shared'
}

type SummaryPage = { data: Summary[]; total: number }
type MockFn = ReturnType<typeof jest.fn>

type StoreState = {
  landingPageChatsDisplayed: number
  landingPageLayoutMode: 'cards' | 'compact'
  landingPageGalleryWidth: 'compact' | 'expanded'
  homepageCharacterLibrarySettings: Record<string, unknown>
  favorites: string[]
  landingHiddenCharacterIds: string[]
  settingsLoaded: boolean
  activeChatId: string | null
  openModal: MockFn
  openSettings: MockFn
  toggleFavorite: MockFn
  setEditingCharacterId: MockFn
  setSetting: MockFn
  logout: MockFn
  user: { username: string; id: string } | null
  wallpaper: { global?: { image_id?: string | null } }
  profiles: Array<{ id: string; is_default?: boolean; name: string }>
  activeProfileId: string | null
  activeLoomPresetId: string | null
  loomRegistry: Record<string, { name: string }>
  characters: Array<{
    id: string
    name: string
    avatar_path: string | null
    image_id: string | null
    extensions: Record<string, unknown>
  }>
  extensions: Array<{ identifier: string; enabled: boolean; has_frontend: boolean }>
  landingRecentChats: null
  setLandingRecentChats: MockFn
  updateCharacter: MockFn
  addCharacter: MockFn
}

const listSummaries = jest.fn()
const listTags = jest.fn()
const getHomepagePreview = jest.fn()
const listRecentGrouped = jest.fn()
const deleteTemporary = jest.fn()
const deleteChat = jest.fn()
const deleteCharacterChats = jest.fn()
const patchMetadata = jest.fn()
const createTemporary = jest.fn()
const createChat = jest.fn()
const branchChat = jest.fn()
const listMessages = jest.fn()
const navigate = jest.fn()
const readDeviceLandingPageStartTab = jest.fn(() => 'characters')

let storeState: StoreState

function defaultHomepageSettings(enabled = true): Record<string, unknown> {
  return {
    enabled,
    thumbnailWidth: 220,
    thumbnailHeight: 280,
    density: 'balanced',
    footerMode: 'balanced',
    visibleMetadata: ['creator', 'tags'],
    tagRows: 1,
    viewMode: 'grid',
    defaultSort: 'recent',
    defaultFilter: 'characters',
    maxVisibleTags: 6,
    showNameBackground: false,
    panelWidth: 420,
    panelImageHeight: 320,
    panelPinned: false,
    lastSelectedCharacterId: null,
  }
}

const storeListeners = new Set<() => void>()

function notifyStore() {
  for (const listener of storeListeners) listener()
}

function createStoreState(enabled = true): StoreState {
  const setSetting = jest.fn((key: string, value: unknown) => {
    if (key === 'landingPageGalleryWidth') {
      storeState = { ...storeState, landingPageGalleryWidth: value as 'compact' | 'expanded' }
    }
    if (key === 'homepageCharacterLibrarySettings' && value && typeof value === 'object') {
      storeState = {
        ...storeState,
        homepageCharacterLibrarySettings: value as Record<string, unknown>,
      }
    }
    notifyStore()
  })
  return {
    landingPageChatsDisplayed: 12,
    landingPageLayoutMode: 'cards',
    landingPageGalleryWidth: 'compact',
    homepageCharacterLibrarySettings: defaultHomepageSettings(enabled),
    favorites: [],
    landingHiddenCharacterIds: [],
    settingsLoaded: true,
    activeChatId: null,
    openModal: jest.fn(),
    openSettings: jest.fn(),
    toggleFavorite: jest.fn(),
    setEditingCharacterId: jest.fn(),
    setSetting,
    logout: jest.fn(),
    user: { username: 'test-user', id: 'test-user-id' },
    wallpaper: { global: null },
    profiles: [],
    activeProfileId: null,
    activeLoomPresetId: null,
    loomRegistry: {},
    characters: [],
    extensions: [],
    landingRecentChats: null,
    setLandingRecentChats: jest.fn(),
    updateCharacter: jest.fn(),
    addCharacter: jest.fn(),
  }
}

const useStore = Object.assign(
  (selector: (state: StoreState) => unknown) => selector(useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener)
      return () => { storeListeners.delete(listener) }
    },
    () => storeState,
    () => storeState,
  )),
  { getState: () => storeState },
)

mock.module('@/store', () => ({ useStore }))
mock.module('react-router', () => ({ useNavigate: () => navigate }))
mock.module('@/api/characters', () => ({
  charactersApi: {
    listSummaries,
    listTags,
    getHomepagePreview,
  },
}))
mock.module('@/api/chats', () => ({
  chatsApi: {
    listRecentGrouped,
    deleteTemporary,
    delete: deleteChat,
    deleteCharacterChats,
    patchMetadata,
    createTemporary,
    create: createChat,
    branch: branchChat,
  },
  messagesApi: { list: listMessages },
}))
mock.module('@/api/images', () => ({ imagesApi: { largeUrl: (id: string) => `/images/${id}` } }))
const wsHandlers = new Map<string, Set<(payload: any) => void>>()
const wsOn = jest.fn((event: string, handler: (payload: any) => void) => {
  const handlers = wsHandlers.get(event) ?? new Set<(payload: any) => void>()
  handlers.add(handler)
  wsHandlers.set(event, handlers)
  return () => handlers.delete(handler)
})
mock.module('@/ws/client', () => ({ wsClient: { on: wsOn } }))
mock.module('@/ws/events', () => ({
  EventType: {
    CHAT_DELETED: 'chat-deleted',
    CHARACTER_EDITED: 'character-edited',
  },
}))
mock.module('@/hooks/useScrollGate', () => ({ useScrollGate: jest.fn() }))
mock.module('@/hooks/useCharacterTheme', () => ({ warmCharacterPalette: jest.fn() }))
mock.module('@/hooks/useLongPress', () => ({ useLongPress: () => ({}) }))
mock.module('@/lib/imageDecodeCache', () => ({
  holdImagesForTransition: jest.fn(),
  prefetchImages: jest.fn(),
}))
mock.module('@/lib/uiScale', () => ({
  measureLayoutHeight: () => 0,
  renderedPxToLayoutPx: (value: number) => value,
}))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarLargeUrlById: (_id: string, imageId?: string | null) => imageId ? `/avatar-${imageId}.png` : '/avatar.png',
  getCharacterAvatarThumbUrlById: (_id: string, imageId?: string | null) => imageId ? `/avatar-${imageId}-thumb.png` : '/avatar-thumb.png',
}))
mock.module('@/lib/formatRelativeTime', () => ({ formatRelativeTime: () => 'just now' }))
mock.module('@/lib/tagColors', () => ({ getTagColorVar: () => '128,128,128' }))
mock.module('@/lib/uiProductivityDefaults', () => ({
  PRODUCTIVITY_DEFAULTS: { homepageCharacterLibrarySettings: defaultHomepageSettings(true) },
}))
mock.module('@/lib/landingPageStartTab', () => ({ readDeviceLandingPageStartTab }))
mock.module('@/lib/deviceRotation', () => ({
  doesDeviceRotationNeedPermission: () => false,
  isDeviceRotationSupported: () => false,
  requestDeviceRotationPermission: async () => ({ state: 'denied' }),
  subscribeDeviceRotation: () => () => {},
}))
mock.module('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

mock.module('@/components/shared/Spinner', () => ({
  Spinner: () => <span role="status" aria-label="Loading" />,
}))
mock.module('@/components/shared/ContextMenu', () => ({ default: () => null }))
mock.module('@/components/shared/SearchField', () => ({
  default: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) => (
    <input aria-label={placeholder} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))
mock.module('@/components/shared/SortControl', () => ({
  SortControl: ({ title, value }: { title: string; value: string }) => (
    <button type="button" aria-label={title}>{value}</button>
  ),
}))
mock.module('@/components/shared/LazyImage', () => ({
  default: ({ src, alt, fallback, loading, decoding }: { src: string; alt: string; fallback?: ReactNode; loading?: 'eager' | 'lazy'; decoding?: 'sync' | 'async' | 'auto' }) => src ? <img src={src} alt={alt} loading={loading} decoding={decoding} /> : fallback ?? null,
}))
mock.module('@/components/shared/FormComponents', () => ({
  Button: ({ children, onClick, disabled, title, className }: { children?: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; className?: string }) => (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={className}>{children}</button>
  ),
}))

const Icon = () => null
mock.module('lucide-react', () => ({
  MessageSquarePlus: Icon,
  MessageSquare: Icon,
  Trash2: Icon,
  Users: Icon,
  LogOut: Icon,
  FlaskConical: Icon,
  Gamepad2: Icon,
  Compass: Icon,
  EyeOff: Icon,
  Star: Icon,
  Pencil: Icon,
  Copy: Icon,
  GitBranch: Icon,
  Maximize2: Icon,
  Minimize2: Icon,
  BookOpen: Icon,
  Edit3: Icon,
  Pin: Icon,
  PinOff: Icon,
  Search: Icon,
  Settings: Icon,
  ArrowLeft: Icon,
  X: Icon,
}))

const MotionDiv = forwardRef<HTMLDivElement, Record<string, any>>((props, ref) => {
  const {
    initial,
    animate,
    exit: _exit,
    variants: _variants,
    transition: _transition,
    onAnimationComplete: _onAnimationComplete,
    ...domProps
  } = props
  return <div
    ref={ref}
    data-motion-initial={initial === false ? 'false' : JSON.stringify(initial)}
    data-motion-animate={typeof animate === 'string' ? animate : JSON.stringify(animate)}
    {...domProps}
  />
})
mock.module('motion/react', () => ({
  motion: { div: MotionDiv },
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => count > 0 ? [{ index: 0, key: 'row-0', start: 0, end: 100, size: 100, lane: 0 }] : [],
    getTotalSize: () => 100,
    measure: jest.fn(),
    containerRef: jest.fn(),
    measureElement: jest.fn(),
  }),
}))
mock.module('./LandingPage.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
mock.module('./HomepageCharacterLibrary.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const TestObserverInstances: TestIntersectionObserver[] = []
class TestIntersectionObserver {
  private disconnected = false
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    TestObserverInstances.push(this)
  }
  observe() {}
  disconnect() { this.disconnected = true }
  trigger() {
    if (this.disconnected) return
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}
Object.assign(globalThis, { IntersectionObserver: TestIntersectionObserver })
Object.assign(domWindow, { IntersectionObserver: TestIntersectionObserver })

const englishI18n = createInstance()
mock.module('@/i18n', () => ({ default: englishI18n }))
const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = []

function summary(id: string, name: string, library_scope: 'mine' | 'shared' = 'mine'): Summary {
  return {
    id,
    name,
    creator: 'Test creator',
    folder: '',
    tags: [],
    image_id: null,
    created_at: 1,
    updated_at: 1,
    has_alternate_greetings: false,
    library_scope,
  }
}

function recentChat(id: string, name: string) {
  return {
    ...summary(id, name),
    latest_chat_id: `chat-${id}`,
    latest_chat_name: 'Recent chat',
    character_id: id,
    character_name: name,
    character_avatar_path: null,
    character_image_id: null,
    updated_at: 1,
    is_group: false,
    chat_count: 1,
  }
}

function convertedGroupChat(id: string, name: string) {
  return {
    ...recentChat(id, name),
    latest_chat_id: `group-${id}-branch`,
    latest_chat_name: `${name} branch`,
    is_group: true,
    chat_count: 2,
    group_character_ids: [id],
    group_name: `${name} group`,
  }
}

function page(data: Summary[], total = data.length): SummaryPage {
  return { data, total }
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
  })
}

async function mountLanding() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })
  await act(async () => {
    root.render(<I18nextProvider i18n={englishI18n}><LandingPage /></I18nextProvider>)
    await Promise.resolve()
  })
  return host
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

function tab(host: HTMLDivElement, name: 'Chats' | 'Characters') {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find(
    (candidate) => candidate.textContent?.trim() === name,
  )
}

function charactersMount(host: HTMLDivElement) {
  return host.querySelector<HTMLElement>('[data-spindle-mount="landing_characters"]')!
}

function appendReadySuiteRoot(host: HTMLDivElement) {
  if (!storeState.extensions.some((extension) => extension.identifier === 'lumiverse_suite')) {
    storeState = {
      ...storeState,
      extensions: [{ identifier: 'lumiverse_suite', enabled: true, has_frontend: true }],
    }
  }
  const root = document.createElement('section')
  root.dataset.homepageCharacterLibraryRoot = 'true'
  root.dataset.homepageCharacterLibraryReady = 'true'
  root.dataset.component = 'HomepageCharacterLibrary'
  root.dataset.spindleExtId = 'lumiverse_suite'
  root.textContent = 'Character Library'
  charactersMount(host).append(root)
  return root
}

function button(host: HTMLDivElement, name: string) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
  )
}

function buttonMatching(host: HTMLDivElement, pattern: RegExp) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => pattern.test(candidate.textContent ?? ''))
}

function countExactText(host: HTMLDivElement, value: string) {
  const walker = document.createTreeWalker(host, domWindow.NodeFilter.SHOW_TEXT)
  let count = 0
  let current: Node | null
  while ((current = walker.nextNode())) {
    if (current.nodeValue?.trim() === value) count += 1
  }
  return count
}

async function settleDeferred<T>(deferred: Deferred<T>, value: T) {
  await act(async () => {
    deferred.resolve(value)
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeAll(async () => {
  await englishI18n.use(initReactI18next).init({
    resources: { en: { landing, panels, common } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: LandingPage } = await import('./LandingPage'))
})

afterEach(async () => {
  const roots = mountedRoots.splice(0)
  await act(async () => {
    for (const { root } of roots) root.unmount()
  })
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-tauri-desktop')
  document.documentElement.removeAttribute('data-platform')
  domWindow.localStorage.clear()
  clearLandingPageSnapshot()
  TestObserverInstances.splice(0)
  listSummaries.mockReset()
  listTags.mockReset()
  getHomepagePreview.mockReset()
  listRecentGrouped.mockReset()
  deleteTemporary.mockReset()
  deleteChat.mockReset()
  deleteCharacterChats.mockReset()
  patchMetadata.mockReset()
  createTemporary.mockReset()
  createChat.mockReset()
  branchChat.mockReset()
  listMessages.mockReset()
  navigate.mockReset()
  wsHandlers.clear()
  wsOn.mockClear()
  readDeviceLandingPageStartTab.mockReset()
  readDeviceLandingPageStartTab.mockReturnValue('characters')
  Object.defineProperty(domWindow, 'innerWidth', { configurable: true, value: 1024 })
  storeState = createStoreState()
})

describe('LandingPage character library', () => {
  test('opens chat history for forked one-member converted groups', async () => {
    storeState = createStoreState(false)
    listRecentGrouped.mockResolvedValue(page([convertedGroupChat('character-1', 'Ava')]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    await click(buttonMatching(host, /Ava group/)!)

    expect(storeState.openModal).toHaveBeenCalledWith('manageChats', {
      characterId: 'character-1',
      characterName: 'Ava group',
      isGroupChat: true,
      groupCharacterIds: ['character-1'],
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  test('uses the landing scroller for resized gallery pagination and de-duplicates observer entries', async () => {
    storeState = createStoreState(false)
    const nextPage = createDeferred<SummaryPage>()
    listRecentGrouped
      .mockResolvedValueOnce(page([recentChat('character-1', 'Ava')], 2))
      .mockReturnValueOnce(nextPage.promise)
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    const observer = TestObserverInstances.at(-1)
    expect(observer?.options.root).toBe(host.querySelector('[data-component="LandingPage"]'))

    await act(async () => {
      observer?.trigger()
      observer?.trigger()
      await Promise.resolve()
    })
    expect(listRecentGrouped).toHaveBeenCalledTimes(2)

    await settleDeferred(nextPage, page([recentChat('character-2', 'Bea')], 2))
    expect(listRecentGrouped).toHaveBeenCalledTimes(2)
  })

  test('ignores a persisted desktop expanded width when paginating on mobile', async () => {
    Object.defineProperty(domWindow, 'innerWidth', { configurable: true, value: 390 })
    storeState = {
      ...createStoreState(false),
      landingPageGalleryWidth: 'expanded',
    }
    listRecentGrouped
      .mockResolvedValueOnce(page([recentChat('character-1', 'Ava')], 2))
      .mockResolvedValueOnce(page([recentChat('character-2', 'Bea')], 2))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    expect(listRecentGrouped.mock.calls[0]?.[0]?.limit).toBe(12)
    expect(host.querySelector('[data-component="LandingPageCharacters"]')?.classList.contains('contentExpanded')).toBe(false)

    await act(async () => {
      TestObserverInstances.at(-1)?.trigger()
      await Promise.resolve()
    })
    await flush()

    expect(listRecentGrouped).toHaveBeenCalledTimes(2)
    expect(listRecentGrouped.mock.calls[1]?.[0]?.limit).toBe(12)
  })

  test('loads the next Chats page when the landing scroller reaches its bottom', async () => {
    storeState = createStoreState(false)
    listRecentGrouped
      .mockResolvedValueOnce(page([recentChat('character-1', 'Ava')], 2))
      .mockResolvedValueOnce(page([recentChat('character-2', 'Bea')], 2))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()
    const scroller = host.querySelector<HTMLElement>('[data-component="LandingPage"]')!
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    })

    await act(async () => {
      scroller.dispatchEvent(new domWindow.Event('scroll', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()

    expect(listRecentGrouped).toHaveBeenCalledTimes(2)
    expect(listRecentGrouped.mock.calls[1]?.[0]?.limit).toBe(listRecentGrouped.mock.calls[0]?.[0]?.limit)
  })

  test('restores loaded Chats without replaying card entry animation while refreshing', async () => {
    storeState = createStoreState(false)
    listRecentGrouped.mockResolvedValueOnce(page([recentChat('character-1', 'Ava')]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const firstHost = await mountLanding()
    await flush()
    expect(firstHost.querySelector('.cardEntry')).not.toBeNull()
    expect(firstHost.querySelector('.cardShine')).not.toBeNull()

    const scroller = firstHost.querySelector<HTMLElement>('[data-component="LandingPage"]')!
    scroller.scrollTop = 420
    const refresh = createDeferred<SummaryPage>()
    listRecentGrouped.mockReturnValueOnce(refresh.promise)

    await click(buttonMatching(firstHost, /Ava/)!)
    const storedSnapshot = JSON.parse(domWindow.sessionStorage.getItem('__lumiverse_landing_page_snapshot_v1') || '{}')
    expect(storedSnapshot.snapshot?.imageUrls).toEqual(['/avatar.png'])

    const mounted = mountedRoots.find((entry) => entry.host === firstHost)!
    mountedRoots.splice(mountedRoots.indexOf(mounted), 1)
    await act(async () => mounted.root.unmount())
    firstHost.remove()

    const restoredHost = await mountLanding()

    expect(restoredHost.textContent).toContain('Ava')
    expect(restoredHost.querySelector('img[alt="Ava"]')?.getAttribute('loading')).toBe('eager')
    expect(restoredHost.querySelector('.cardEntry')).toBeNull()
    expect(restoredHost.querySelector('[data-entry-mode="chat-return"]')?.classList.contains('routeEntering')).toBe(true)
    expect(restoredHost.querySelector('[data-entry-mode="chat-return"]')?.getAttribute('data-motion-initial')).toBe('{"opacity":0,"y":10,"scale":0.985}')
    expect(restoredHost.querySelector('[data-entry-mode="chat-return"]')?.getAttribute('data-motion-animate')).toBe('{"opacity":1,"y":0,"scale":1}')
    expect(restoredHost.querySelector<HTMLElement>('[data-component="LandingPage"]')?.scrollTop).toBe(420)
    expect(listRecentGrouped).toHaveBeenCalledTimes(2)

    await settleDeferred(refresh, page([recentChat('character-1', 'Ava')]))
  })

  test('keeps the inverse return animation and bounded synchronous images in macOS Tauri', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    document.documentElement.setAttribute('data-platform', 'macos')
    storeState = createStoreState(false)
    const ava = recentChat('character-1', 'Ava')
    writeLandingPageSnapshot({
      userId: 'test-user-id',
      items: [ava],
      total: 1,
      scrollTop: 0,
      requestedTab: 'chats',
      searchQuery: '',
      sortField: 'recent',
      sortDirection: 'desc',
      pageSize: 12,
      galleryWidth: 'compact',
      mainWidth: 960,
      chatViewportHeight: 700,
      viewportWidth: domWindow.innerWidth,
      viewportHeight: domWindow.innerHeight,
      imageUrls: ['/avatar.png'],
    })
    listRecentGrouped.mockResolvedValue(page([ava]))

    const host = await mountLanding()
    const landing = host.querySelector('[data-entry-mode="chat-return"]')

    expect(landing?.classList.contains('routeEntering')).toBe(true)
    expect(landing?.getAttribute('data-motion-initial')).toBe('{"opacity":0,"y":10,"scale":0.985}')
    expect(landing?.getAttribute('data-motion-animate')).toBe('{"opacity":1,"y":0,"scale":1}')
    expect(host.querySelector('img[alt="Ava"]')?.getAttribute('loading')).toBe('eager')
    expect(host.querySelector('img[alt="Ava"]')?.getAttribute('decoding')).toBe('sync')
  })

  test('reconciles a restored chat card with character edits before the refresh resolves', async () => {
    storeState = createStoreState(false)
    storeState.characters = [{
      id: 'character-1',
      name: 'Bea',
      avatar_path: 'bea.png',
      image_id: 'bea-image',
      extensions: {},
    }]
    writeLandingPageSnapshot({
      userId: 'test-user-id',
      items: [recentChat('character-1', 'Ava')],
      total: 1,
      scrollTop: 0,
      requestedTab: 'chats',
      searchQuery: '',
      sortField: 'recent',
      sortDirection: 'desc',
      pageSize: 12,
      galleryWidth: 'compact',
      mainWidth: 960,
      chatViewportHeight: 700,
      viewportWidth: domWindow.innerWidth,
      viewportHeight: domWindow.innerHeight,
    })
    const refresh = createDeferred<SummaryPage>()
    listRecentGrouped.mockReturnValue(refresh.promise)

    const host = await mountLanding()

    expect(countExactText(host, 'Bea')).toBeGreaterThan(0)
    expect(countExactText(host, 'Ava')).toBe(0)
    expect(host.querySelector('img[alt="Bea"]')?.getAttribute('src')).toBe('/avatar-bea-image.png')

    await settleDeferred(refresh, page([recentChat('character-1', 'Bea')]))
  })

  test('applies a late character edit immediately and then refreshes landing ordering', async () => {
    storeState = createStoreState(false)
    writeLandingPageSnapshot({
      userId: 'test-user-id',
      items: [recentChat('character-1', 'Ava')],
      total: 1,
      scrollTop: 0,
      requestedTab: 'chats',
      searchQuery: '',
      sortField: 'recent',
      sortDirection: 'desc',
      pageSize: 12,
      galleryWidth: 'compact',
      mainWidth: 960,
      chatViewportHeight: 700,
      viewportWidth: domWindow.innerWidth,
      viewportHeight: domWindow.innerHeight,
    })
    const refresh = createDeferred<SummaryPage>()
    listRecentGrouped.mockReturnValue(refresh.promise)
    const host = await mountLanding()

    await act(async () => {
      for (const handler of wsHandlers.get('character-edited') ?? []) {
        handler({
          id: 'character-1',
          character: {
            id: 'character-1',
            name: 'Bea',
            avatar_path: 'bea.png',
            image_id: 'bea-image',
            extensions: {},
          },
        })
      }
      await Promise.resolve()
    })

    expect(countExactText(host, 'Bea')).toBeGreaterThan(0)
    expect(countExactText(host, 'Ava')).toBe(0)
    expect(host.querySelector('img[alt="Bea"]')?.getAttribute('src')).toBe('/avatar-bea-image.png')
    expect(listRecentGrouped).toHaveBeenCalledTimes(2)

    await settleDeferred(refresh, page([recentChat('character-1', 'Bea')]))
  })

  test('recovers the landing snapshot after refreshing inside a chat route', async () => {
    storeState = createStoreState(false)
    const ava = { ...recentChat('character-1', 'Ava'), character_avatar_path: null }
    domWindow.sessionStorage.setItem('__lumiverse_landing_page_snapshot_v1', JSON.stringify({
      version: 1,
      snapshot: {
        userId: 'test-user-id',
        items: [ava],
        total: 1,
        scrollTop: 240,
        requestedTab: 'chats',
        searchQuery: '',
        sortField: 'recent',
        sortDirection: 'desc',
        pageSize: 12,
        galleryWidth: 'compact',
        mainWidth: 960,
        chatViewportHeight: 700,
        viewportWidth: domWindow.innerWidth,
        viewportHeight: domWindow.innerHeight,
      },
    }))
    const refresh = createDeferred<SummaryPage>()
    listRecentGrouped.mockReturnValue(refresh.promise)

    const host = await mountLanding()

    expect(host.textContent).toContain('Ava')
    expect(host.querySelector('[data-entry-mode="chat-return"]')?.getAttribute('data-motion-initial')).toBe('{"opacity":0,"y":10,"scale":0.985}')
    expect(host.querySelector('.cardEntry')).toBeNull()
    expect(host.querySelector<HTMLElement>('[data-component="LandingPage"]')?.scrollTop).toBe(240)
    expect(domWindow.sessionStorage.getItem('__lumiverse_landing_page_snapshot_v1')).toBeNull()

    await settleDeferred(refresh, page([ava]))
  })

  test('restores the expanded gallery geometry instead of its default-width topology', async () => {
    Object.defineProperty(domWindow, 'innerWidth', { configurable: true, value: 2200 })
    storeState = {
      ...createStoreState(false),
      landingPageGalleryWidth: 'expanded',
    }
    const ava = { ...recentChat('character-1', 'Ava'), character_avatar_path: null }
    writeLandingPageSnapshot({
      userId: 'test-user-id',
      items: [ava],
      total: 1,
      scrollTop: 0,
      requestedTab: 'chats',
      searchQuery: '',
      sortField: 'recent',
      sortDirection: 'desc',
      pageSize: 27,
      galleryWidth: 'expanded',
      mainWidth: 2000,
      chatViewportHeight: 700,
      viewportWidth: 2200,
      viewportHeight: domWindow.innerHeight,
    })
    const refresh = createDeferred<SummaryPage>()
    listRecentGrouped.mockReturnValue(refresh.promise)

    const host = await mountLanding()

    expect(host.querySelector('[data-component="LandingPageCharacters"]')?.classList.contains('contentExpanded')).toBe(true)
    expect(host.querySelector('[data-component="LandingPageChats"]')?.getAttribute('data-layout-columns')).toBe('9')
    expect(listRecentGrouped.mock.calls[0]?.[0]?.limit).toBe(36)

    await settleDeferred(refresh, page([ava]))
  })

  test('uses the last expanded card presentation for the cold-load skeleton', async () => {
    Object.defineProperty(domWindow, 'innerWidth', { configurable: true, value: 2200 })
    storeState = {
      ...createStoreState(false),
      settingsLoaded: false,
    }
    domWindow.localStorage.setItem('__lumiverse_landing_hint', JSON.stringify({
      layout: 'cards',
      count: 36,
      galleryWidth: 'expanded',
      mainWidth: 2000,
      chatViewportHeight: 700,
      viewportWidth: 2200,
      viewportHeight: domWindow.innerHeight,
    }))

    const host = await mountLanding()

    expect(host.querySelector('[data-component="LandingPageCharacters"]')?.classList.contains('contentExpanded')).toBe(true)
    expect(host.querySelectorAll('.skeletonCard')).toHaveLength(36)
    expect(host.querySelector('.gridCards')).not.toBeNull()
    expect(host.querySelector('.listSkeleton')).toBeNull()
    expect(host.querySelector('[data-entry-mode="fresh"]')?.classList.contains('routeEntering')).toBe(false)
    expect(host.querySelector('[data-entry-mode="fresh"]')?.getAttribute('data-motion-initial')).toBe('{"opacity":0}')
    expect(host.querySelector('[data-entry-mode="fresh"]')?.getAttribute('data-motion-animate')).toBe('{"opacity":1}')
    expect(listRecentGrouped).not.toHaveBeenCalled()
  })

  test('uses the last compact-list presentation for the cold-load skeleton', async () => {
    storeState = {
      ...createStoreState(false),
      settingsLoaded: false,
    }
    domWindow.localStorage.setItem('__lumiverse_landing_hint', JSON.stringify({
      layout: 'compact',
      count: 8,
      galleryWidth: 'compact',
      mainWidth: 960,
      chatViewportHeight: 700,
      viewportWidth: domWindow.innerWidth,
      viewportHeight: domWindow.innerHeight,
    }))

    const host = await mountLanding()

    expect(host.querySelectorAll('.listSkeleton')).toHaveLength(8)
    expect(host.querySelector('.compactList')).not.toBeNull()
    expect(host.querySelector('.skeletonCard')).toBeNull()
    expect(listRecentGrouped).not.toHaveBeenCalled()
  })

  test('uses the normal loading reveal for a chat-to-home navigation without a snapshot', async () => {
    storeState = createStoreState(false)
    listRecentGrouped.mockResolvedValue(page([recentChat('character-1', 'Ava')]))
    markLandingPageChatReturn()

    const host = await mountLanding()
    await flush()

    expect(host.querySelector('[data-entry-mode="cold-return"]')?.getAttribute('data-motion-initial')).toBe('{"opacity":0}')
    expect(host.querySelector('[data-entry-mode="cold-return"]')?.getAttribute('data-motion-animate')).toBe('{"opacity":1}')
    expect(host.querySelector('.cardEntry')).not.toBeNull()
  })

  test('uses the normal fade and bounded synchronous images for a cold macOS Tauri return', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    document.documentElement.setAttribute('data-platform', 'macos')
    storeState = createStoreState(false)
    listRecentGrouped.mockResolvedValue(page([recentChat('character-1', 'Ava')]))
    markLandingPageChatReturn()

    const host = await mountLanding()
    await flush()

    expect(host.querySelector('[data-entry-mode="cold-return"]')?.getAttribute('data-motion-initial')).toBe('{"opacity":0}')
    expect(host.querySelector('img[alt="Ava"]')?.getAttribute('loading')).toBe('eager')
    expect(host.querySelector('img[alt="Ava"]')?.getAttribute('decoding')).toBe('sync')
  })

  test('eagerly requests bounded rows but keeps decoding asynchronous in non-macOS Tauri', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    document.documentElement.setAttribute('data-platform', 'linux')
    storeState = createStoreState(false)
    listRecentGrouped.mockResolvedValue(page([recentChat('character-1', 'Ava')]))

    const host = await mountLanding()
    await flush()

    expect(host.querySelector('img[alt="Ava"]')?.getAttribute('loading')).toBe('eager')
    expect(host.querySelector('img[alt="Ava"]')?.getAttribute('decoding')).toBe('async')
  })

  test('keeps the recent-chat gallery compact by default and can expand it', async () => {
    storeState = createStoreState(false)
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    const widthButton = host.querySelector<HTMLButtonElement>('[aria-label="Expand gallery to full width"]')
    expect(widthButton?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => widthButton?.click())

    expect(storeState.landingPageGalleryWidth).toBe('expanded')
    expect(storeState.setSetting).toHaveBeenLastCalledWith('landingPageGalleryWidth', 'expanded')
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Use compact gallery width"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  test('shows native Chats without tab chrome before and after the suite surface is disabled', async () => {
    storeState = createStoreState(false)
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    expect(host.querySelectorAll('button[role="tab"]')).toHaveLength(0)
    expect(tab(host, 'Characters')).toBeUndefined()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.querySelector('[data-component="LandingPageChatsPanel"]')?.hasAttribute('role')).toBe(false)
    expect(host.querySelector('[data-component="LandingPageChatsPanel"]')?.hasAttribute('aria-labelledby')).toBe(false)
    expect(host.textContent).toContain('No recent chats')
    expect(listSummaries).not.toHaveBeenCalled()

    const root = appendReadySuiteRoot(host)
    await flush()
    root.remove()
    await flush()

    expect(host.querySelectorAll('button[role="tab"]')).toHaveLength(0)
    expect(tab(host, 'Characters')).toBeUndefined()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')
  })

  test('adds Characters when one suite root becomes ready and switches tabs without writing settings', async () => {
    storeState = createStoreState()
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')
    expect(listSummaries).not.toHaveBeenCalled()

    appendReadySuiteRoot(host)
    await flush()

    expect(tab(host, 'Characters')?.getAttribute('aria-selected')).toBe('true')
    expect(tab(host, 'Chats')?.getAttribute('aria-selected')).toBe('false')
    expect(charactersMount(host).querySelectorAll('[data-homepage-character-library-root]')).toHaveLength(1)
    expect(charactersMount(host).querySelectorAll('[data-component="HomepageCharacterLibrary"]')).toHaveLength(1)
    expect(listSummaries).not.toHaveBeenCalled()
    expect(listRecentGrouped).toHaveBeenCalledTimes(1)
    expect(storeState.setSetting).not.toHaveBeenCalledWith('landingPageActiveTab', expect.anything())

    await click(tab(host, 'Chats')!)

    expect(tab(host, 'Chats')?.getAttribute('aria-selected')).toBe('true')
    expect(storeState.setSetting).not.toHaveBeenCalledWith('landingPageActiveTab', expect.anything())
  })

  test('uses the device-local Suite start preference after the character surface is ready', async () => {
    readDeviceLandingPageStartTab.mockReturnValue('chats')
    storeState = createStoreState()
    storeState.user = { username: 'test-user', id: 'suite-user' } as StoreState['user']
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    appendReadySuiteRoot(host)
    await flush()

    expect(tab(host, 'Chats')?.getAttribute('aria-selected')).toBe('true')
    expect(readDeviceLandingPageStartTab).toHaveBeenCalledWith('suite-user')
  })

  test('returns to native Chats when the suite root is removed', async () => {
    storeState = createStoreState()
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    const root = appendReadySuiteRoot(host)
    await flush()
    expect(tab(host, 'Characters')?.getAttribute('aria-selected')).toBe('true')

    root.remove()
    await flush()

    expect(tab(host, 'Characters')).toBeUndefined()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.querySelector('[data-component="LandingPageChatsPanel"]')?.hasAttribute('role')).toBe(false)
    expect(host.textContent).toContain('No recent chats')
    expect(listSummaries).not.toHaveBeenCalled()
  })

  test('re-adding the suite root activates once per ready transition and preserves Chats', async () => {
    storeState = createStoreState()
    listRecentGrouped.mockResolvedValue(page([]))
    listTags.mockResolvedValue([])
    getHomepagePreview.mockResolvedValue(null)

    const host = await mountLanding()
    await flush()

    const firstRoot = appendReadySuiteRoot(host)
    await flush()
    expect(storeState.setSetting).not.toHaveBeenCalledWith('landingPageActiveTab', expect.anything())
    firstRoot.append(document.createElement('span'))
    await flush()
    expect(storeState.setSetting).not.toHaveBeenCalledWith('landingPageActiveTab', expect.anything())

    firstRoot.remove()
    await flush()
    expect(tab(host, 'Chats')).toBeUndefined()
    expect(host.textContent).toContain('No recent chats')

    appendReadySuiteRoot(host)
    await flush()

    expect(tab(host, 'Characters')?.getAttribute('aria-selected')).toBe('true')
    expect(storeState.setSetting).not.toHaveBeenCalledWith('landingPageActiveTab', expect.anything())
    expect(charactersMount(host).querySelectorAll('[data-homepage-character-library-root]')).toHaveLength(1)
    expect(listRecentGrouped).toHaveBeenCalledTimes(1)
    expect(listSummaries).not.toHaveBeenCalled()
  })
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
