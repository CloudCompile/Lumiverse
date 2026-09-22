import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const domWindow = dom.window as unknown as Window & typeof globalThis
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalIntersectionObserver = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  HTMLElement: domWindow.HTMLElement,
  HTMLImageElement: domWindow.HTMLImageElement,
  Event: domWindow.Event,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let createRoot: typeof CreateRoot
let LazyImage: typeof import('./LazyImage').default
let HomepageLibraryCardImage: typeof import('@/components/landing/HomepageLibraryCardImage').default
let clearImageCache: typeof import('@/lib/imageDecodeCache').clearImageCache
let rememberImageDecoded: typeof import('@/lib/imageDecodeCache').rememberImageDecoded
const roots: Root[] = []

beforeAll(async () => {
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: LazyImage } = await import('./LazyImage'))
  ;({ default: HomepageLibraryCardImage } = await import('@/components/landing/HomepageLibraryCardImage'))
  ;({ clearImageCache, rememberImageDecoded } = await import('@/lib/imageDecodeCache'))
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-tauri-desktop')
  document.documentElement.removeAttribute('data-platform')
  if (originalIntersectionObserver) {
    Object.defineProperty(globalThis, 'IntersectionObserver', originalIntersectionObserver)
  } else {
    delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver
  }
  clearImageCache()
})

afterAll(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as { document?: Document }).document
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete (globalThis as { window?: Window }).window
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete (globalThis as { navigator?: Navigator }).navigator
})

async function renderCachedImage() {
  rememberImageDecoded('/cached.webp')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<LazyImage src="/cached.webp" alt="Cached" />))
  return host.querySelector('img')!
}

function installTestIntersectionObserver() {
  let observerCallback: IntersectionObserverCallback | null = null
  let observerInstance: IntersectionObserver | null = null
  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = '320px 0px'
    readonly scrollMargin = '0px'
    readonly thresholds = [0]

    constructor(callback: IntersectionObserverCallback) {
      observerCallback = callback
      observerInstance = this
    }

    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] { return [] }
    unobserve() {}
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: TestIntersectionObserver,
  })

  return (target: Element) => {
    observerCallback!([{
      isIntersecting: true,
      target,
    } as unknown as IntersectionObserverEntry], observerInstance!)
  }
}

describe('LazyImage decoded-image presentation', () => {
  test('uses recent decode metadata as the normal browser fast path', async () => {
    const image = await renderCachedImage()
    expect(image.style.opacity).toBe('1')
  })

  test('waits for the mounted image element in the macOS Tauri WebView', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    document.documentElement.setAttribute('data-platform', 'macos')

    const image = await renderCachedImage()
    let resolveDecode!: () => void
    const decoded = new Promise<void>((resolve) => { resolveDecode = resolve })
    Object.defineProperty(image, 'decode', { configurable: true, value: () => decoded })
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      image.dispatchEvent(new domWindow.Event('load'))
      await Promise.resolve()
    })
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      resolveDecode()
      await decoded
      await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()))
    })
    expect(image.style.visibility).toBe('visible')
  })
})

describe('homepage library image memory contract', () => {
  test('requests only near-viewport cards and reveals after the mounted WKWebView element decodes', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    document.documentElement.setAttribute('data-platform', 'macos')
    const intersect = installTestIntersectionObserver()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(
      <HomepageLibraryCardImage src="/library-card.webp" alt="Library card" />,
    ))

    const image = host.querySelector('img')!
    expect(image.hasAttribute('src')).toBe(false)
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      intersect(image)
    })

    let resolveDecode!: () => void
    const decoded = new Promise<void>((resolve) => { resolveDecode = resolve })
    Object.defineProperty(image, 'decode', { configurable: true, value: () => decoded })

    expect(image.getAttribute('src')).toBe('/library-card.webp')
    expect(image.getAttribute('loading')).toBe('eager')
    expect(image.getAttribute('decoding')).toBe('sync')
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      image.dispatchEvent(new domWindow.Event('load'))
      await Promise.resolve()
    })
    expect(image.style.visibility).toBe('hidden')

    await act(async () => {
      resolveDecode()
      await decoded
      await new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve()))
    })
    expect(image.style.visibility).toBe('visible')
  })

  test('bounds non-macOS Tauri requests without applying the WKWebView paint guard', async () => {
    document.documentElement.setAttribute('data-tauri-desktop', '')
    const intersect = installTestIntersectionObserver()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(
      <HomepageLibraryCardImage src="/windows-card.webp" alt="Windows card" />,
    ))

    const image = host.querySelector('img')!
    expect(image.hasAttribute('src')).toBe(false)
    expect(image.style.visibility).toBe('hidden')

    await act(async () => intersect(image))

    expect(image.getAttribute('src')).toBe('/windows-card.webp')
    expect(image.getAttribute('loading')).toBe('eager')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(image.style.visibility).toBe('visible')
  })
})
