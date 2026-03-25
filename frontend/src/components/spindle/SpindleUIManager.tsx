import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useStore } from '@/store'
import SpindleFloatWidget from './SpindleFloatWidget'
import SpindleDockPanel from './SpindleDockPanel'
import SpindleAppMount from './SpindleAppMount'
import ExpandedTextEditor from '@/components/shared/ExpandedTextEditor'
import ContextMenu, { type ContextMenuEntry } from '@/components/shared/ContextMenu'

function SpindleTextEditor() {
  const reqId = useStore((s) => s.pendingTextEditor?.requestId ?? null)
  const req = useStore((s) => s.pendingTextEditor)
  const closeTextEditor = useStore((s) => s.closeTextEditor)
  const [value, setValue] = useState('')
  const reqRef = useRef(req)
  const valueRef = useRef(value)
  reqRef.current = req
  valueRef.current = value

  useEffect(() => {
    if (req) setValue(req.value ?? '')
  }, [reqId])

  // Stable close handler — never changes identity, reads from refs
  const handleClose = useRef(() => {
    const r = reqRef.current
    if (!r) return
    closeTextEditor(r.requestId, valueRef.current, false)
  })
  handleClose.current = () => {
    const r = reqRef.current
    if (!r) return
    closeTextEditor(r.requestId, valueRef.current, false)
  }

  const onClose = useCallback(() => handleClose.current(), [])

  if (!req) return null

  return (
    <ExpandedTextEditor
      value={value}
      onChange={setValue}
      onClose={onClose}
      title={req.title}
      placeholder={req.placeholder}
    />
  )
}

export default function SpindleUIManager() {
  const floatWidgets = useStore((s) => s.floatWidgets)
  const dockPanels = useStore((s) => s.dockPanels)
  const appMounts = useStore((s) => s.appMounts)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)

  return (
    <>
      {floatWidgets
        .filter((w) => w.visible && !hiddenPlacements.includes(w.id))
        .map((w) => (
          <SpindleFloatWidget key={w.id} widget={w} />
        ))}

      {dockPanels
        .filter((p) => !hiddenPlacements.includes(p.id))
        .map((p) => (
          <SpindleDockPanel key={p.id} panel={p} />
        ))}

      {appMounts
        .filter((m) => !hiddenPlacements.includes(m.id))
        .map((m) => (
          <SpindleAppMount key={m.id} mount={m} />
        ))}

      <SpindleTextEditor />
      <SpindleContextMenu />
    </>
  )
}

function SpindleContextMenu() {
  const req = useStore((s) => s.pendingContextMenu)
  const closeContextMenu = useStore((s) => s.closeContextMenu)

  const items: ContextMenuEntry[] = useMemo(() => {
    if (!req) return []
    return req.items.map((item) => {
      if (item.type === 'divider') {
        return { key: item.key, type: 'divider' as const }
      }
      return {
        key: item.key,
        label: item.label,
        disabled: item.disabled,
        danger: item.danger,
        active: item.active,
        onClick: () => closeContextMenu(req.requestId, item.key),
      }
    })
  }, [req, closeContextMenu])

  if (!req) return null

  return (
    <ContextMenu
      position={req.position}
      items={items}
      onClose={() => closeContextMenu(req.requestId, null)}
    />
  )
}
