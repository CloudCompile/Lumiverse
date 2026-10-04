import { useEffect, useCallback, useRef, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import styles from './ModalShell.module.css'
import clsx from 'clsx'

interface ModalShellProps {
  isOpen: boolean
  onClose: () => void
  maxWidth?: string | number
  maxHeight?: string | number
  zIndex?: number
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
  /** Use the available viewport without desktop size caps. */
  fullscreen?: boolean
  /** Allow a modal body with form controls to scroll when the viewport is short. */
  scrollable?: boolean
  modalId?: string
}

export function ModalShell({
  isOpen,
  onClose,
  maxWidth = 560,
  maxHeight = 'calc(85dvh / var(--lumiverse-ui-scale, 1))',
  zIndex = 10002,
  closeOnBackdrop = true,
  closeOnEscape = true,
  children,
  className,
  style,
  fullscreen = false,
  scrollable = false,
  modalId = 'shell',
}: ModalShellProps) {
  const backdropPointerDownRef = useRef<EventTarget | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose, closeOnEscape])

  const handleBackdropPointerDown = useCallback((e: React.PointerEvent) => {
    backdropPointerDownRef.current = e.target === e.currentTarget ? e.currentTarget : null
  }, [])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (
        closeOnBackdrop
        && e.target === e.currentTarget
        && backdropPointerDownRef.current === e.currentTarget
      ) {
        onClose()
      }
    },
    [onClose, closeOnBackdrop],
  )

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={clsx(styles.backdrop, fullscreen && styles.fullscreenBackdrop)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onPointerDown={handleBackdropPointerDown}
          onClick={handleBackdropClick}
          style={{ zIndex }}
        >
          <motion.div
            className={clsx(styles.modal, fullscreen && styles.fullscreenModal, scrollable && styles.scrollable, className)}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            // A caller's viewport-unit limit also needs to fit the available
            // backdrop at larger UI scales and while a keyboard is open.
            style={{
              maxWidth: fullscreen ? undefined : maxWidth,
              maxHeight: fullscreen ? undefined : `min(${typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}, 100%)`,
              ...style,
            }}
          >
            <span data-spindle-mount="modal_header_actions" data-spindle-scope={`modal:${modalId}:header-actions`} style={{ display: 'contents' }} />
            {children}
            <span data-spindle-mount="modal_footer_actions" data-spindle-scope={`modal:${modalId}:footer-actions`} style={{ display: 'contents' }} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
