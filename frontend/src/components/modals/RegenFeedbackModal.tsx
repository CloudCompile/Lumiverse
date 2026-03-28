import { useState, useEffect, useCallback, useRef } from 'react'
import { MessageSquareText } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import styles from './RegenFeedbackModal.module.css'
import clsx from 'clsx'

interface RegenFeedbackModalProps {
  onSubmit: (feedback: string) => void
  onSkip: () => void
  onCancel: () => void
}

export default function RegenFeedbackModal({
  onSubmit,
  onSkip,
  onCancel,
}: RegenFeedbackModalProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Auto-focus textarea
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (trimmed) onSubmit(trimmed)
  }, [text, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <ModalShell isOpen={true} onClose={onCancel} maxWidth="clamp(320px, 90vw, min(520px, var(--lumiverse-content-max-width, 520px)))" className={styles.modal}>
          <div className={styles.header}>
            <MessageSquareText size={16} />
            <h3 className={styles.title}>Regeneration Feedback</h3>
          </div>

          <p className={styles.subtitle}>
            Provide guidance for the next generation. This will be included as an OOC instruction.
          </p>

          <div className={styles.body}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Make the response shorter, focus on dialogue, change the tone to be more playful..."
              rows={4}
            />

            <div className={styles.actions}>
              <button
                type="button"
                className={clsx(styles.btn, styles.btnCancel)}
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className={clsx(styles.btn, styles.btnSkip)}
                onClick={onSkip}
              >
                Skip
              </button>
              <button
                type="button"
                className={clsx(styles.btn, styles.btnSubmit)}
                onClick={handleSubmit}
                disabled={!text.trim()}
              >
                Regenerate
              </button>
            </div>
          </div>
    </ModalShell>
  )
}
