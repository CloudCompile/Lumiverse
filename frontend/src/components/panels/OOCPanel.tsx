import { useStore } from '@/store'
import { Toggle } from '@/components/shared/Toggle'
import { FormField, Select } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import type { OOCStyleType } from '@/types/store'
import styles from './OOCPanel.module.css'

const STYLE_OPTIONS = [
  { value: 'social', label: 'Social Card' },
  { value: 'margin', label: 'Margin Note' },
  { value: 'whisper', label: 'Whisper Bubble' },
  { value: 'raw', label: 'Raw Text' },
  { value: 'irc', label: 'IRC Chat Room' },
]

export default function OOCPanel() {
  const oocEnabled = useStore((s) => s.oocEnabled)
  const lumiaOOCStyle = useStore((s) => s.lumiaOOCStyle)
  const lumiaOOCInterval = useStore((s) => s.lumiaOOCInterval)
  const ircUseLeetHandles = useStore((s) => s.ircUseLeetHandles)
  const setSetting = useStore((s) => s.setSetting)

  return (
    <div className={styles.panel}>
      {/* Enable toggle */}
      <Toggle.Checkbox
        checked={oocEnabled}
        onChange={(checked) => setSetting('oocEnabled', checked)}
        label="Enable OOC comments"
      />

      {oocEnabled && (
        <>
          {/* Style selector */}
          <FormField label="Display Style" hint="How OOC comments appear in chat">
            <Select
              value={lumiaOOCStyle}
              onChange={(v) => setSetting('lumiaOOCStyle', v as OOCStyleType)}
              options={STYLE_OPTIONS}
            />
          </FormField>

          {/* IRC-specific: L33tspeak handles */}
          {lumiaOOCStyle === 'irc' && (
            <Toggle.Checkbox
              checked={ircUseLeetHandles}
              onChange={(checked) => setSetting('ircUseLeetHandles', checked)}
              label="L33tspeak Handles"
            />
          )}

          {/* Interval */}
          <FormField label="OOC Interval" hint="Messages between OOC comments (empty = automatic)">
            <NumberStepper
              value={lumiaOOCInterval}
              onChange={(v) => setSetting('lumiaOOCInterval', v)}
              min={1}
              max={50}
              step={1}
              allowEmpty
            />
          </FormField>
        </>
      )}
    </div>
  )
}
