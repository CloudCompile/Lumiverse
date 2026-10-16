// Real editor, reset and theme variables; controlled API/store/preview boundaries.
// EDITOR_BROWSERS=chromium,firefox,webkit; no server or login required.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import * as playwright from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const stubs = {
  '@/store': 'export const useStore = selector => selector({})',
  '@/api/macros': 'export const getMacroCatalog = async () => ({ categories: [] })',
  '@/lib/loom/service': 'export const getAvailableMacros = () => []',
  '@/components/chat/MessageContent': 'export default () => null',
}
const bundle = await build({
  absWorkingDir: root, entryPoints: ['frontend/tests/expanded-editor.fixture.tsx'],
  outfile: 'expanded-editor-fixture.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'controlled-editor', setup(build) {
    build.onResolve({ filter: /^@\// }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }],
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const change = async (page, method, value) => {
  await page.evaluate(([method, value]) => window.expandedEditorFixture[method](value), [method, value])
  await settle(page)
  // Toolbar buttons transition font-size for 150ms. Their wrapping can move
  // the editor after the font itself has updated, invalidating click coordinates.
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))))
  await settle(page)
}
const checkMetrics = async (page, label) => {
  const metrics = await page.evaluate(() => {
    const textarea = document.querySelector('textarea'), pre = document.querySelector('pre')
    const a = getComputedStyle(textarea), b = getComputedStyle(pre)
    return { font: [a.fontSize, b.fontSize], line: [a.lineHeight, b.lineHeight], scroll: [textarea.scrollHeight, pre.scrollHeight], client: [textarea.clientWidth, pre.clientWidth] }
  })
  assert.equal(metrics.font[0], metrics.font[1], `${label} font size`)
  assert.equal(metrics.line[0], metrics.line[1], `${label} line height`)
  assert.equal(metrics.client[0], metrics.client[1], `${label} wrapping width`)
  assert.ok(Math.abs(metrics.scroll[0] - metrics.scroll[1]) <= 1, `${label} wrapping: ${JSON.stringify(metrics)}`)
}

let cases = 0
for (const name of (process.argv.find(arg => arg.startsWith('--browsers='))?.split('=')[1] ?? process.env.EDITOR_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await playwright[name].launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<html data-tauri-desktop data-platform="macos"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`)
    await page.addScriptTag({ content: js })
    await page.waitForFunction(() => !!window.expandedEditorFixture)
    const initialValue = await page.locator('textarea').inputValue()
    for (const width of [1200, 800, 390]) for (const uiScale of [1, 0.8, 1.25]) for (const highlighted of [true, false]) {
      await page.setViewportSize({ width, height: 900 })
      await change(page, 'setUiScale', uiScale)
      await change(page, 'setHighlighted', highlighted)
      for (const fontScale of [1, 0.85, 1.05, 1.25, 1.5, 1.75, 2, 1]) {
        const label = `${name}/${width}/ui=${uiScale}/highlighted=${highlighted}/font=${fontScale}`
        await change(page, 'setFontScale', fontScale)
        await page.locator('textarea').evaluate(el => {
          el.focus({ preventScroll: true }); el.setSelectionRange(0, 0); el.scrollTop = 0
          document.querySelector('pre').scrollTop = 0
        })
        await settle(page)
        await checkMetrics(page, label)
        // Only highlighted fields paint a mirror to click against. A hidden
        // plain mirror can return empty Range rectangles in some browsers.
        for (const offset of highlighted ? [5, 50, 90, 185, 360, 640] : []) {
          const caret = await page.evaluate(offset => {
            const pre = document.querySelector('pre'), textarea = document.querySelector('textarea')
            const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
            let node, remaining = offset
            while ((node = walker.nextNode())) {
              if (remaining >= node.textContent.length) { remaining -= node.textContent.length; continue }
              const range = document.createRange()
              range.setStart(node, remaining); range.collapse(true)
              const rect = range.getBoundingClientRect(), box = textarea.getBoundingClientRect()
              return rect.top > box.top + 16 && rect.bottom < box.bottom - 16 ? rect.toJSON() : null
            }
          }, offset)
          if (!caret) continue
          await page.mouse.click(caret.x + 0.5, caret.y + caret.height / 2)
          await settle(page)
          const actual = await page.locator('textarea').evaluate(el => el.selectionStart)
          assert.equal(actual, offset, `${label} native caret at ${offset}`)
        }
        assert.deepEqual(errors, [], `${label} browser errors`)
        cases++
      }
      if (uiScale === 1.25 && !highlighted) console.log(`${name}/${width}: font and UI scale checks passed`)
    }
    // Keep short/empty fields aligned too, and exercise the shared inline styles.
    await page.setViewportSize({ width: 800, height: 900 })
    await change(page, 'setUiScale', 1.25)
    await change(page, 'setFontScale', 1.75)
    for (const inline of [false, true]) for (const highlighted of [true, false]) {
      await change(page, 'setInline', inline)
      await change(page, 'setHighlighted', highlighted)
      for (const value of ['', 'short {{char}}\n\n', initialValue]) {
        await change(page, 'setValue', value)
        await checkMetrics(page, `${name}/inline=${inline}/highlighted=${highlighted}/length=${value.length}`)
        cases++
      }
      // A real click and edit after scrolling into a long document must target
      // the visible character even after fonts and wrapping widths change.
      await page.locator('textarea').evaluate(el => {
        el.focus({ preventScroll: true }); el.setSelectionRange(0, 0)
      })
      await settle(page)
      await page.locator('textarea').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })
      await settle(page)
      const scrolls = await page.evaluate(() => [document.querySelector('textarea').scrollTop, document.querySelector('pre').scrollTop])
      assert.ok(Math.abs(scrolls[0] - scrolls[1]) <= 1, `${name} mirrored scroll: ${scrolls}`)
      if (!highlighted) continue
      const target = await page.evaluate(() => {
        const textarea = document.querySelector('textarea'), pre = document.querySelector('pre')
        const box = textarea.getBoundingClientRect(), walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
        let node, offset = 0
        while ((node = walker.nextNode())) {
          for (let i = 0; i < node.textContent.length; i += 7) {
            if (/\s/.test(node.textContent[i])) continue
            const range = document.createRange()
            range.setStart(node, i); range.collapse(true)
            const rect = range.getBoundingClientRect()
            if (rect.top > box.top + 40 && rect.bottom < box.bottom - 40) return { offset: offset + i, x: rect.x + 0.5, y: rect.y + rect.height / 2 }
          }
          offset += node.textContent.length
        }
        return { error: 'no caret', box: box.toJSON(), scroll: [textarea.scrollTop, pre.scrollTop], length: offset }
      })
      assert.ok(target && !target.error, `${name}/inline=${inline}/highlighted=${highlighted} mirrored scroll and visible caret: ${JSON.stringify(target)}`)
      await page.mouse.click(target.x, target.y)
      await settle(page)
      assert.equal(await page.locator('textarea').evaluate(el => el.selectionStart), target.offset, `${name} scrolled caret`)
      await page.keyboard.insertText('!')
      assert.equal(await page.locator('textarea').inputValue(), initialValue.slice(0, target.offset) + '!' + initialValue.slice(target.offset), `${name} scrolled edit`)
    }
    assert.deepEqual(errors, [], `${name} browser errors`)
    await page.close()
  } finally { await browser.close() }
  console.log(`${name}: font scale caret checks passed`)
}
console.log(`${cases} expanded editor scale cases passed`)
