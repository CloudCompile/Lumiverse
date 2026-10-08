import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(join(root, 'frontend/package.json'))
const { chromium, firefox, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const ts = require('typescript')
const main = readFileSync(join(root, 'frontend/src/main.tsx'), 'utf8')
const start = main.indexOf('if ((window.navigator as any).standalone === true && navigator.maxTouchPoints > 0) {', main.indexOf('// Two WebKit bugs'))
const end = main.indexOf('// ── Mobile layout recovery', start)
assert.ok(start >= 0 && end > start, 'Installed-iOS guard anchors changed')
const guard = ts.transpile(main.slice(start, end), { target: ts.ScriptTarget.ESNext })
const directory = mkdtempSync(join(tmpdir(), 'spindle-touch-scroll-'))
try {
  const entry = join(directory, 'fixture.ts'), bundle = join(directory, 'fixture.js')
  const spindle = join(root, 'frontend/src/lib/spindle').replaceAll('\\', '/')
  writeFileSync(entry, `import { registerLiveRoot } from ${JSON.stringify(spindle + '/live-root-registry.ts')};
import { setWidgetTouchScrollMode, usesNativeWidgetTouchScroll } from ${JSON.stringify(spindle + '/widget-touch-scroll.ts')};
window.fixture = { registerLiveRoot, setWidgetTouchScrollMode, usesNativeWidgetTouchScroll };`)
  const build = spawnSync('bun', ['build', entry, '--target=browser', '--outfile=' + bundle], { encoding: 'utf8', windowsHide: true })
  assert.equal(build.status, 0, build.stderr)
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.setContent('<body><div id="core"></div><div id="widget"><div id="other"></div></div></body>')
        await page.addScriptTag({ content: readFileSync(bundle, 'utf8') })
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'standalone', { value: true })
          Object.defineProperty(navigator, 'maxTouchPoints', { value: 1 })
        })
        await page.addScriptTag({ content: `{ const usesNativeWidgetTouchScroll = window.fixture.usesNativeWidgetTouchScroll;
const findScrollableAncestor = () => null; const installKeyboardFocusReveal = () => {};
${guard} }` })
        const results = await page.evaluate(() => {
          const { registerLiveRoot, setWidgetTouchScrollMode } = window.fixture
          const core = document.querySelector('#core'), widget = document.querySelector('#widget'), other = document.querySelector('#other')
          const off = registerLiveRoot('a', widget, 'ui_panels', 1)
          const offOther = registerLiveRoot('b', other, 'ui_panels', 1)
          const move = target => {
            const event = new Event('touchmove', { bubbles: true, composed: true, cancelable: true })
            Object.defineProperty(event, 'touches', { value: [{ clientX: 0, clientY: 20 }] })
            target.dispatchEvent(event); return event.defaultPrevented
          }
          const result = [move(core), move(widget)]
          setWidgetTouchScrollMode(widget, 'native')
          result.push(move(widget), move(core), move(other))
          const child = document.createElement('button')
          widget.attachShadow({ mode: 'open' }).append(child)
          result.push(move(child))
          setWidgetTouchScrollMode(widget, 'guarded')
          result.push(move(child))
          setWidgetTouchScrollMode(widget, 'native')
          off()
          result.push(move(child))
          offOther()
          return result
        })
        assert.deepEqual(errors, [])
        assert.deepEqual(results, [true, true, false, true, true, false, true, true])
        await page.close()
        console.log(`${name} ${viewport.width}px: default, opt-in, isolation, shadow content, reversal and teardown passed`)
      }
    } finally { await browser.close() }
  }
  console.log('Synthetic touch cancellation audit passed; physical installed-iOS scrolling is not simulated.')
} finally { rmSync(directory, { recursive: true, force: true }) }
