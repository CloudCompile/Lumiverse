import { useState, useEffect, useCallback, useRef } from 'react'
import { Save, ChevronDown, MoreVertical, RefreshCw, Trash2, Link, Unlink, Pencil, Check, X } from 'lucide-react'
import { useStore } from '@/store'
import { loadoutsApi } from '@/api/loadouts'
import { toast } from '@/lib/toast'
import type { Loadout, LoadoutBinding } from '@/api/loadouts'
import styles from './LoadoutSelector.module.css'
import clsx from 'clsx'

export default function LoadoutSelector() {
  const loadouts = useStore((s) => s.loadouts)
  const activeLoadoutId = useStore((s) => s.activeLoadoutId)
  const loadLoadouts = useStore((s) => s.loadLoadouts)
  const createLoadout = useStore((s) => s.createLoadout)
  const updateLoadout = useStore((s) => s.updateLoadout)
  const deleteLoadout = useStore((s) => s.deleteLoadout)
  const applyLoadout = useStore((s) => s.applyLoadout)
  const setActiveLoadoutId = useStore((s) => s.setActiveLoadoutId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [chatBinding, setChatBinding] = useState<LoadoutBinding | null>(null)
  const [charBinding, setCharBinding] = useState<LoadoutBinding | null>(null)

  const dropdownRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Load loadouts on mount
  useEffect(() => { loadLoadouts() }, [loadLoadouts])

  // Load bindings when chat/character changes
  useEffect(() => {
    if (activeChatId) {
      loadoutsApi.getChatBinding(activeChatId).then(setChatBinding).catch(() => setChatBinding(null))
    } else {
      setChatBinding(null)
    }
  }, [activeChatId])

  useEffect(() => {
    if (activeCharacterId) {
      loadoutsApi.getCharacterBinding(activeCharacterId).then(setCharBinding).catch(() => setCharBinding(null))
    } else {
      setCharBinding(null)
    }
  }, [activeCharacterId])

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false)
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const activeLoadout = loadouts.find((l) => l.id === activeLoadoutId)

  const handleSelect = useCallback(async (loadout: Loadout) => {
    setDropdownOpen(false)
    await applyLoadout(loadout.id)
    toast.success(`Applied loadout: ${loadout.name}`)
  }, [applyLoadout])

  const handleSelectCustom = useCallback(() => {
    setDropdownOpen(false)
    setActiveLoadoutId(null)
  }, [setActiveLoadoutId])

  const handleSave = useCallback(async () => {
    if (!saveName.trim()) return
    const loadout = await createLoadout(saveName.trim())
    if (loadout) {
      toast.success(`Saved loadout: ${loadout.name}`)
      setActiveLoadoutId(loadout.id)
    }
    setSaving(false)
    setSaveName('')
  }, [saveName, createLoadout, setActiveLoadoutId])

  const handleRecapture = useCallback(async () => {
    if (!activeLoadoutId) return
    await updateLoadout(activeLoadoutId, { recapture: true })
    toast.success('Loadout updated with current settings')
    setMenuOpen(false)
  }, [activeLoadoutId, updateLoadout])

  const handleDelete = useCallback(async () => {
    if (!activeLoadoutId) return
    const name = activeLoadout?.name
    await deleteLoadout(activeLoadoutId)
    toast.success(`Deleted loadout: ${name}`)
    setMenuOpen(false)
  }, [activeLoadoutId, activeLoadout, deleteLoadout])

  const handleRename = useCallback(async () => {
    if (!renaming || !renameName.trim()) return
    await updateLoadout(renaming, { name: renameName.trim() })
    setRenaming(null)
    setRenameName('')
    setMenuOpen(false)
  }, [renaming, renameName, updateLoadout])

  const handleBindChat = useCallback(async () => {
    if (!activeChatId || !activeLoadoutId) return
    try {
      const binding = await loadoutsApi.setChatBinding(activeChatId, activeLoadoutId)
      setChatBinding(binding)
      toast.success('Loadout bound to this chat')
    } catch {
      toast.error('Failed to bind loadout')
    }
    setMenuOpen(false)
  }, [activeChatId, activeLoadoutId])

  const handleUnbindChat = useCallback(async () => {
    if (!activeChatId) return
    try {
      await loadoutsApi.deleteChatBinding(activeChatId)
      setChatBinding(null)
      toast.success('Chat binding removed')
    } catch {
      toast.error('Failed to remove binding')
    }
    setMenuOpen(false)
  }, [activeChatId])

  const handleBindCharacter = useCallback(async () => {
    if (!activeCharacterId || !activeLoadoutId) return
    try {
      const binding = await loadoutsApi.setCharacterBinding(activeCharacterId, activeLoadoutId)
      setCharBinding(binding)
      toast.success('Loadout bound to this character')
    } catch {
      toast.error('Failed to bind loadout')
    }
    setMenuOpen(false)
  }, [activeCharacterId, activeLoadoutId])

  const handleUnbindCharacter = useCallback(async () => {
    if (!activeCharacterId) return
    try {
      await loadoutsApi.deleteCharacterBinding(activeCharacterId)
      setCharBinding(null)
      toast.success('Character binding removed')
    } catch {
      toast.error('Failed to remove binding')
    }
    setMenuOpen(false)
  }, [activeCharacterId])

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        {/* Dropdown selector */}
        <div className={styles.selectorWrap} ref={dropdownRef}>
          <button
            type="button"
            className={styles.selector}
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <span className={styles.selectorLabel}>
              {activeLoadout ? activeLoadout.name : 'Custom'}
            </span>
            <ChevronDown size={12} className={clsx(styles.chevron, dropdownOpen && styles.chevronOpen)} />
          </button>

          {dropdownOpen && (
            <div className={styles.dropdown}>
              <button
                type="button"
                className={clsx(styles.dropdownItem, !activeLoadoutId && styles.dropdownItemActive)}
                onClick={handleSelectCustom}
              >
                Custom
              </button>
              {loadouts.map((loadout) => (
                <button
                  key={loadout.id}
                  type="button"
                  className={clsx(styles.dropdownItem, activeLoadoutId === loadout.id && styles.dropdownItemActive)}
                  onClick={() => handleSelect(loadout)}
                >
                  {renaming === loadout.id ? (
                    <div className={styles.renameRow} onClick={(e) => e.stopPropagation()}>
                      <input
                        className={styles.renameInput}
                        value={renameName}
                        onChange={(e) => setRenameName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(null) }}
                        autoFocus
                      />
                      <button type="button" className={styles.renameBtn} onClick={handleRename}><Check size={11} /></button>
                      <button type="button" className={styles.renameBtn} onClick={() => setRenaming(null)}><X size={11} /></button>
                    </div>
                  ) : (
                    loadout.name
                  )}
                </button>
              ))}
              {loadouts.length === 0 && (
                <div className={styles.dropdownEmpty}>No saved loadouts</div>
              )}
            </div>
          )}
        </div>

        {/* Save button */}
        {saving ? (
          <div className={styles.saveRow}>
            <input
              className={styles.saveInput}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setSaving(false); setSaveName('') } }}
              placeholder="Loadout name..."
              autoFocus
            />
            <button type="button" className={styles.saveConfirm} onClick={handleSave} disabled={!saveName.trim()}>
              <Check size={12} />
            </button>
            <button type="button" className={styles.saveCancel} onClick={() => { setSaving(false); setSaveName('') }}>
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.saveBtn}
            onClick={() => setSaving(true)}
            title="Save current settings as loadout"
          >
            <Save size={12} />
          </button>
        )}

        {/* Menu button (only when a loadout is active) */}
        {activeLoadoutId && (
          <div className={styles.menuWrap} ref={menuRef}>
            <button
              type="button"
              className={styles.menuBtn}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreVertical size={12} />
            </button>

            {menuOpen && (
              <div className={styles.menu}>
                <button type="button" className={styles.menuItem} onClick={() => {
                  setRenaming(activeLoadoutId)
                  setRenameName(activeLoadout?.name || '')
                  setMenuOpen(false)
                  setDropdownOpen(true)
                }}>
                  <Pencil size={11} /> Rename
                </button>
                <button type="button" className={styles.menuItem} onClick={handleRecapture}>
                  <RefreshCw size={11} /> Re-capture
                </button>
                {activeChatId && (
                  chatBinding?.loadout_id === activeLoadoutId ? (
                    <button type="button" className={styles.menuItem} onClick={handleUnbindChat}>
                      <Unlink size={11} /> Unbind Chat
                    </button>
                  ) : (
                    <button type="button" className={styles.menuItem} onClick={handleBindChat}>
                      <Link size={11} /> Bind to Chat
                    </button>
                  )
                )}
                {activeCharacterId && (
                  charBinding?.loadout_id === activeLoadoutId ? (
                    <button type="button" className={styles.menuItem} onClick={handleUnbindCharacter}>
                      <Unlink size={11} /> Unbind Character
                    </button>
                  ) : (
                    <button type="button" className={styles.menuItem} onClick={handleBindCharacter}>
                      <Link size={11} /> Bind to Character
                    </button>
                  )
                )}
                <button type="button" className={clsx(styles.menuItem, styles.menuItemDanger)} onClick={handleDelete}>
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
