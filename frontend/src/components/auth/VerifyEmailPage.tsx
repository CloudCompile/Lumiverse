import { useNavigate } from 'react-router'
import { motion, LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import styles from './LoginPage.module.css'
import clsx from 'clsx'

export default function VerifyEmailPage() {
  const navigate = useNavigate()

  return (
    <LazyMotion features={domAnimation} strict={false}>
    <MotionConfig reducedMotion="user">
    <div className={styles.page}>
      {/* Ambient background */}
      <div className={styles.bg}>
        <div className={clsx(styles.bgGlow, styles.bgGlow1)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow2)} />
        <div className={clsx(styles.bgGlow, styles.bgGlow3)} />
      </div>

      {/* Grid pattern */}
      <div className={styles.grid} />

      {/* Content */}
      <div className={styles.content}>
        {/* Logo */}
        <motion.div
          className={styles.logoBlock}
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={styles.logoIcon}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="36" height="36">
              <g transform="rotate(-12, 32, 32)">
                <ellipse cx="32" cy="12" rx="18" ry="6" fill="#8B5A2B" />
                <ellipse cx="32" cy="12" rx="14" ry="4" fill="#A0522D" />
                <rect x="14" y="12" width="36" height="40" fill="#8B5FC7" />
                <line x1="14" y1="18" x2="50" y2="18" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="24" x2="50" y2="24" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="30" x2="50" y2="30" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="36" x2="50" y2="36" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="42" x2="50" y2="42" stroke="#7A4EB8" strokeWidth="1.5" />
                <line x1="14" y1="48" x2="50" y2="48" stroke="#7A4EB8" strokeWidth="1.5" />
                <rect x="14" y="12" width="8" height="40" fill="#A78BD4" opacity="0.5" />
                <ellipse cx="32" cy="52" rx="18" ry="6" fill="#8B5A2B" />
                <rect x="14" y="48" width="36" height="4" fill="#8B5FC7" />
                <ellipse cx="32" cy="52" rx="14" ry="4" fill="#A0522D" />
                <ellipse cx="32" cy="52" rx="5" ry="2" fill="#5D3A1A" />
                <path d="M 48 35 Q 55 38 52 45 Q 49 52 56 58" fill="none" stroke="#8B5FC7" strokeWidth="2" strokeLinecap="round" />
              </g>
            </svg>
          </div>
          <h1 className={styles.logoTitle}>Lumiverse</h1>
          <p className={styles.logoSubtitle}>Verification</p>
        </motion.div>

        {/* Card */}
        <motion.div
          className={styles.card}
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={styles.cardHighlight} />

          <div className={styles.form}>
            <motion.div
              className={styles.field}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.3 }}
            >
              <div style={{ textAlign: 'center', fontSize: 'calc(14px * var(--lumiverse-font-scale, 1))', lineHeight: '1.5', color: 'var(--lumiverse-text)' }}>
                <p>Email verification is not required for this instance.</p>
                <p style={{ marginTop: '12px', color: 'var(--lumiverse-text-hint)' }}>
                  Please proceed to <a href="/login" style={{ color: 'var(--lumiverse-primary-500)', textDecoration: 'none' }}>login</a>.
                </p>
              </div>
            </motion.div>

            <motion.button
              onClick={() => navigate('/login')}
              className={styles.submitBtn}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.4 }}
              whileHover={{ scale: 1.015 }}
              whileTap={{ scale: 0.985 }}
            >
              Go to Login
            </motion.button>
          </div>
        </motion.div>

        {/* Footer */}
        <motion.p
          className={styles.footer}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.7 }}
        >
          Your story awaits
        </motion.p>
      </div>
    </div>
    </MotionConfig>
    </LazyMotion>
  )
}
