import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { WifiOff, Download } from 'lucide-react'
import { useStore } from '@/store'
import { Spinner } from './Spinner'
import styles from './ConnectionLostOverlay.module.css'

const RESUME_GRACE_MS = 7_000

export default function ConnectionLostOverlay() {
  const { t } = useTranslation('shared')
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const wsConnected = useStore((s) => s.wsConnected)
  const wsAuthSynced = useStore((s) => s.wsAuthSynced)
  const wsRoundTripVerified = useStore((s) => s.wsRoundTripVerified)
  const wsHasEverConnected = useStore((s) => s.wsHasEverConnected)
  const wsUpdatePending = useStore((s) => s.wsUpdatePending)

  const [inResumeGrace, setInResumeGrace] = useState(false)
  const overlayWasShowingAtHideRef = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        const state = useStore.getState()
        const healthyNow = state.wsConnected && state.wsAuthSynced && state.wsRoundTripVerified
        overlayWasShowingAtHideRef.current =
          state.isAuthenticated && state.wsHasEverConnected && !healthyNow
      } else if (document.visibilityState === 'visible') {
        if (!overlayWasShowingAtHideRef.current) {
          setInResumeGrace(true)
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => setInResumeGrace(false), RESUME_GRACE_MS)
        }
        overlayWasShowingAtHideRef.current = false
      }
    }

    document.addEventListener('visibilitychange', onVisChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisChange)
      if (timer) clearTimeout(timer)
    }
  }, [])

  const healthy = wsConnected && wsAuthSynced && wsRoundTripVerified
  const visible =
    isAuthenticated &&
    (wsUpdatePending || (wsHasEverConnected && !healthy && !inResumeGrace))

  const title = wsUpdatePending
    ? t('connectionLost.updatingTitle')
    : t('connectionLost.lostTitle')
  const message = wsUpdatePending
    ? t('connectionLost.updatingMessage')
    : wsConnected
      ? wsAuthSynced
        ? t('connectionLost.verifyingConnection')
        : t('connectionLost.resyncingSession')
      : t('connectionLost.unreachable')
  const statusText = wsUpdatePending
    ? t('connectionLost.installingBundle')
    : wsConnected
      ? t('connectionLost.verifying')
      : t('connectionLost.reconnecting')

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="connection-lost-title"
          aria-describedby="connection-lost-message"
        >
          <motion.div
            className={styles.card}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          >
            <div
              className={wsUpdatePending ? styles.iconRingUpdate : styles.iconRing}
              aria-hidden="true"
            >
              <span className={styles.pulse} />
              {wsUpdatePending ? (
                <Download size={28} strokeWidth={2} />
              ) : (
                <WifiOff size={28} strokeWidth={2} />
              )}
            </div>
            <h2 id="connection-lost-title" className={styles.title}>
              {title}
            </h2>
            <p id="connection-lost-message" className={styles.message}>
              {message}
            </p>
            <span className={styles.status}>
              <Spinner size={14} />
              {statusText}
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
