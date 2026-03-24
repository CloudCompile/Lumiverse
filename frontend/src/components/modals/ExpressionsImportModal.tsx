import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import { expressionsApi } from '@/api/expressions'
import styles from './LorebookImportModal.module.css'

export interface ExpressionsImportInfo {
  characterId: string
  characterName: string
  expressionCount: number
}

interface Props {
  isOpen: boolean
  items: ExpressionsImportInfo[]
  onClose: () => void
}

export default function ExpressionsImportModal({ isOpen, items, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(items.map((i) => i.characterId)))
  const [enabling, setEnabling] = useState(false)

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleEnable = useCallback(async () => {
    setEnabling(true)
    try {
      for (const item of items) {
        if (!selected.has(item.characterId)) continue
        // Expressions were already imported during CHARX import,
        // just ensure they're enabled
        const config = await expressionsApi.get(item.characterId)
        if (config && !config.enabled) {
          await expressionsApi.put(item.characterId, { ...config, enabled: true })
        }
      }
    } finally {
      setEnabling(false)
      onClose()
    }
  }, [items, selected, onClose])

  return createPortal(
    <AnimatePresence>
      {isOpen && items.length > 0 && (
        <motion.div
          className={styles.overlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className={styles.header}>
              <div className={styles.headerLeft}>
                <span className={styles.title}>Imported Expressions</span>
                <span className={styles.badge}>{items.length}</span>
              </div>
              <button type="button" className={styles.closeBtn} onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className={styles.body}>
              <p style={{ fontSize: 12, color: 'var(--lumiverse-text-dim)', margin: '0 0 8px' }}>
                The following characters had expression mappings bundled in their CHARX files.
                Would you like to enable expressions for them?
              </p>
              <div className={styles.lorebookList}>
                {items.map((item) => (
                  <label key={item.characterId} className={styles.lorebookItem}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.characterId)}
                      onChange={() => toggle(item.characterId)}
                    />
                    <div className={styles.lorebookInfo}>
                      <span className={styles.lorebookName}>{item.characterName}</span>
                    </div>
                    <span className={styles.entryBadge}>
                      {item.expressionCount} {item.expressionCount === 1 ? 'expression' : 'expressions'}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.footer}>
              <button type="button" className={styles.skipBtn} onClick={onClose}>
                Skip
              </button>
              <button
                type="button"
                className={styles.importBtn}
                disabled={selected.size === 0 || enabling}
                onClick={handleEnable}
              >
                {enabling ? 'Enabling...' : `Enable ${selected.size > 0 ? selected.size : ''} Expressions`}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
