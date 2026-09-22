import { describe, expect, test } from 'bun:test'

const componentSource = await Bun.file(new URL('./WorldBookEditorModal.tsx', import.meta.url)).text()
const cssSource = await Bun.file(new URL('./WorldBookEditorModal.module.css', import.meta.url)).text()

describe('WorldBookEditorModal fullscreen contract', () => {
  test('closes only after launching the enhanced full editor, with a native fullscreen fallback', () => {
    expect(componentSource).toContain('const [fullscreen, setFullscreen] = useState(false)')
    expect(componentSource).toContain('className={clsx(styles.modal, fullscreen && styles.fullscreen)}')
    expect(componentSource).toContain("canLaunchLorebookEditor('full')")
    expect(componentSource).toContain('if (launched) closeModal()')
    expect(componentSource).toContain("preferredTarget: 'full'")
    expect(componentSource.indexOf("preferredTarget: 'full'")).toBeLessThan(componentSource.indexOf('if (launched) closeModal()'))
    expect(componentSource).toContain('onClick={launchEnhancedEditor}')
    expect(componentSource).toContain('setFullscreen((current) => !current)')
  })

  test('uses the scale-compensated viewport height exactly once', () => {
    const fullscreenBlock = cssSource.match(/\.fullscreen\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(fullscreenBlock).toMatch(/height: var\(--app-scaled-viewport-height, calc\(100dvh \/ var\(--lumiverse-ui-scale, 1\)\)\);/)
    expect(fullscreenBlock).not.toMatch(/height:\s*calc\(var\(--app-scaled-viewport-height/)
  })
})
