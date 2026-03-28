import { useState, useCallback, useEffect } from 'react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { worldBooksApi } from '@/api/world-books'
import type { LorebookInfo } from './BulkImportProgressModal'
import styles from './LorebookImportModal.module.css'

interface LorebookImportModalProps {
  isOpen: boolean
  lorebooks: LorebookInfo[]
  onClose: () => void
}

export default function LorebookImportModal({
  isOpen,
  lorebooks,
  onClose,
}: LorebookImportModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  // Reset selections when lorebooks change (select all by default)
  useEffect(() => {
    setSelected(new Set(lorebooks.map((l) => l.characterId)))
  }, [lorebooks])

  const allSelected = selected.size === lorebooks.length
  const noneSelected = selected.size === 0

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(lorebooks.map((l) => l.characterId)))
    }
  }, [allSelected, lorebooks])

  const toggle = useCallback((characterId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(characterId)) {
        next.delete(characterId)
      } else {
        next.add(characterId)
      }
      return next
    })
  }, [])

  const handleImport = useCallback(async () => {
    if (noneSelected) return
    setImporting(true)
    try {
      const toImport = lorebooks.filter((l) => selected.has(l.characterId))
      await Promise.allSettled(
        toImport.map((l) => worldBooksApi.importCharacterBook(l.characterId))
      )
    } finally {
      setImporting(false)
      onClose()
    }
  }, [lorebooks, selected, noneSelected, onClose])

  return (
    <ModalShell isOpen={isOpen && lorebooks.length > 0} onClose={onClose} maxWidth={580}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>Embedded Lorebooks</span>
          <span className={styles.badge}>{lorebooks.length}</span>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className={styles.body}>
        <div className={styles.selectAll}>
          <Toggle.Checkbox
            checked={allSelected}
            onChange={toggleAll}
            label="Select All"
          />
        </div>

        <div className={styles.lorebookList}>
          {lorebooks.map((lb) => (
            <label key={lb.characterId} className={styles.lorebookItem}>
              <input
                type="checkbox"
                checked={selected.has(lb.characterId)}
                onChange={() => toggle(lb.characterId)}
              />
              <div className={styles.lorebookInfo}>
                <span className={styles.lorebookName}>{lb.lorebookName}</span>
                <span className={styles.lorebookMeta}>from {lb.characterName}</span>
              </div>
              <span className={styles.entryBadge}>
                {lb.entryCount} {lb.entryCount === 1 ? 'entry' : 'entries'}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" onClick={onClose}>
          Skip
        </Button>
        <Button
          variant="primary"
          disabled={noneSelected || importing}
          onClick={handleImport}
        >
          {importing
            ? 'Importing...'
            : allSelected
              ? 'Import All'
              : `Import ${selected.size} Selected`}
        </Button>
      </div>
    </ModalShell>
  )
}
