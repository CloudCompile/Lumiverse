import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import styles from './LorebookImportModal.module.css'

export interface AlternateFieldsSummaryInfo {
  characterName: string
  fieldCounts: Record<string, number>
  hasAlternateAvatars: boolean
}

interface Props {
  isOpen: boolean
  items: AlternateFieldsSummaryInfo[]
  onClose: () => void
}

const FIELD_KEYS: Record<string, 'fieldDescription' | 'fieldPersonality' | 'fieldScenario'> = {
  description: 'fieldDescription',
  personality: 'fieldPersonality',
  scenario: 'fieldScenario',
}

export default function AlternateFieldsSummaryModal({ isOpen, items, onClose }: Props) {
  const { t } = useTranslation('modals', { keyPrefix: 'alternateFieldsSummary' })

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
                <span className={styles.title}>{t('title')}</span>
              </div>
              <button type="button" className={styles.closeBtn} onClick={onClose}>
                <X size={16} />
              </button>
            </div>

            <div className={styles.body}>
              <p style={{ fontSize: 12, color: 'var(--lumiverse-text-dim)', margin: '0 0 8px' }}>
                {t('intro')}
              </p>
              <div className={styles.lorebookList}>
                {items.map((item, i) => (
                  <div key={i} className={styles.lorebookItem} style={{ cursor: 'default' }}>
                    <div className={styles.lorebookInfo}>
                      <span className={styles.lorebookName}>{item.characterName}</span>
                      <span className={styles.lorebookMeta}>
                        {Object.entries(item.fieldCounts)
                          .filter(([, count]) => count > 0)
                          .map(([field, count]) => {
                            const labelKey = FIELD_KEYS[field]
                            const label = labelKey ? t(labelKey) : field
                            return t('variants', { label, count })
                          })
                          .join(', ')}
                        {item.hasAlternateAvatars && `, ${t('alternateAvatars')}`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.footer}>
              <button type="button" className={styles.importBtn} onClick={onClose}>
                {t('gotIt')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
