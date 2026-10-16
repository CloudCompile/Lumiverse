import { StrictMode, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import ExpandedTextEditor from '../src/components/shared/ExpandedTextEditor'
import { generateThemeVariables } from '../src/theme/engine'
import { DEFAULT_THEME } from '../src/theme/presets'
import '../src/theme/reset.css'
import '../src/theme/global.css'

void i18next.use(initReactI18next).init({ lng: 'en', resources: {}, initImmediate: false })

const initialValue = Array.from({ length: 60 }, (_, index) =>
  `${index}: {{char}} {{setvar::name::value}} <tag>**bold** *italic* \`code\`</tag>\t` +
  'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(index % 4 + 1),
).join('\n') + '\n\n'

function Fixture() {
  const [value, setValue] = useState(initialValue)
  const [fontScale, setFontScale] = useState(1)
  const [uiScale, setUiScale] = useState(1)
  const [highlighted, setHighlighted] = useState(true)
  const [inline, setInline] = useState(false)

  useLayoutEffect(() => {
    const vars = generateThemeVariables({ ...DEFAULT_THEME, fontScale, uiScale }, 'dark')
    for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value)
    window.dispatchEvent(new Event('resize'))
  }, [fontScale, uiScale])

  useLayoutEffect(() => {
    Object.assign(window, { expandedEditorFixture: { setFontScale, setUiScale, setHighlighted, setInline, setValue } })
  }, [])

  return <ExpandedTextEditor value={value} onChange={setValue} onClose={() => {}} title="Editor"
    macros={[]} markdownOnly={highlighted} inline={inline} />
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
