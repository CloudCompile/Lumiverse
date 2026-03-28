import { Check } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import type { Character } from '@/types/api'
import styles from './GreetingPickerModal.module.css'
import clsx from 'clsx'

interface GreetingPickerModalProps {
  character: Character
  activeContent?: string
  onSelect: (greetingIndex: number) => void
  onCancel: () => void
}

export default function GreetingPickerModal({
  character,
  activeContent,
  onSelect,
  onCancel,
}: GreetingPickerModalProps) {
  const greetings = [
    { label: 'Default Greeting', content: character.first_mes },
    ...(character.alternate_greetings || []).map((g, i) => ({
      label: `Greeting #${i + 2}`,
      content: g,
    })),
  ]

  return (
    <ModalShell isOpen onClose={onCancel} maxWidth={620} maxHeight="80vh" className={styles.modal}>
      <CloseButton onClick={onCancel} variant="solid" position="absolute" />

      <div className={styles.header}>
        <h3 className={styles.title}>Choose a Greeting</h3>
        <span className={styles.count}>{greetings.length} greetings</span>
      </div>

      <div className={styles.list}>
        {greetings.map((g, i) => {
          const isActive = activeContent !== undefined && g.content === activeContent
          return (
            <button
              key={i}
              type="button"
              className={clsx(styles.card, isActive && styles.cardActive)}
              onClick={() => onSelect(i)}
              style={{ animationDelay: `${Math.min(i * 40, 200)}ms` }}
            >
              <div className={styles.cardHeader}>
                <span className={styles.cardLabel}>{g.label}</span>
                {isActive && (
                  <span className={styles.activeBadge}>
                    <Check size={10} />
                    Active
                  </span>
                )}
              </div>
              <div className={styles.cardPreview}>{g.content}</div>
            </button>
          )
        })}
      </div>
    </ModalShell>
  )
}
