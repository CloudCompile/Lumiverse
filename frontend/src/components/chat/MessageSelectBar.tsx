import { Eye, EyeOff, X, CheckSquare, Square } from 'lucide-react'
import { useMessageSelect } from '@/hooks/useMessageSelect'
import styles from './MessageSelectBar.module.css'
import clsx from 'clsx'

interface MessageSelectBarProps {
  chatId: string
}

export default function MessageSelectBar({ chatId }: MessageSelectBarProps) {
  const {
    selectedCount,
    totalCount,
    hasHiddenSelected,
    hasVisibleSelected,
    exitSelectMode,
    selectAllMessages,
    clearMessageSelection,
    bulkHide,
  } = useMessageSelect(chatId)

  const allSelected = selectedCount === totalCount && totalCount > 0

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <button
          type="button"
          className={styles.selectToggle}
          onClick={allSelected ? clearMessageSelection : selectAllMessages}
          title={allSelected ? 'Deselect all' : 'Select all'}
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>
        <span className={styles.count}>
          {selectedCount} of {totalCount} selected
        </span>
      </div>
      <div className={styles.actions}>
        {hasVisibleSelected && (
          <button
            type="button"
            className={clsx(styles.actionBtn, styles.hideBtn)}
            onClick={() => bulkHide(true)}
            disabled={selectedCount === 0}
          >
            <EyeOff size={13} />
            <span>Hide</span>
          </button>
        )}
        {hasHiddenSelected && (
          <button
            type="button"
            className={clsx(styles.actionBtn, styles.unhideBtn)}
            onClick={() => bulkHide(false)}
            disabled={selectedCount === 0}
          >
            <Eye size={13} />
            <span>Unhide</span>
          </button>
        )}
        <button
          type="button"
          className={clsx(styles.actionBtn, styles.cancelBtn)}
          onClick={exitSelectMode}
        >
          <X size={13} />
          <span>Cancel</span>
        </button>
      </div>
    </div>
  )
}
