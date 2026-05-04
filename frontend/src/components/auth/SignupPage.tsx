import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { motion, LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import styles from './LoginPage.module.css'
import { checkUsernameAvailability, checkEmailAvailability, signup } from '@/api/signup'
import clsx from 'clsx'

export default function SignupPage() {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [focused, setFocused] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null)
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null)
  const [checkingUsername, setCheckingUsername] = useState(false)
  const [checkingEmail, setCheckingEmail] = useState(false)
  const navigate = useNavigate()
  const formRef = useRef<HTMLFormElement>(null)
  const usernameDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const emailDebounceRef = useRef<NodeJS.Timeout | null>(null)

  // Check username availability with debounce
  useEffect(() => {
    if (!username || username.length < 3) {
      setUsernameAvailable(null)
      return
    }

    if (usernameDebounceRef.current) {
      clearTimeout(usernameDebounceRef.current)
    }

    setCheckingUsername(true)
    usernameDebounceRef.current = setTimeout(async () => {
      try {
        const result = await checkUsernameAvailability(username)
        setUsernameAvailable(result.available)
      } catch {
        setUsernameAvailable(null)
      } finally {
        setCheckingUsername(false)
      }
    }, 300)

    return () => {
      if (usernameDebounceRef.current) {
        clearTimeout(usernameDebounceRef.current)
      }
    }
  }, [username])

  // Check email availability with debounce
  useEffect(() => {
    if (!email || !email.includes('@')) {
      setEmailAvailable(null)
      return
    }

    if (emailDebounceRef.current) {
      clearTimeout(emailDebounceRef.current)
    }

    setCheckingEmail(true)
    emailDebounceRef.current = setTimeout(async () => {
      try {
        const result = await checkEmailAvailability(email)
        setEmailAvailable(result.available)
      } catch {
        setEmailAvailable(null)
      } finally {
        setCheckingEmail(false)
      }
    }, 300)

    return () => {
      if (emailDebounceRef.current) {
        clearTimeout(emailDebounceRef.current)
      }
    }
  }, [email])

  const validateForm = () => {
    if (username.length < 3) {
      return 'Username must be at least 3 characters'
    }
    if (!email.includes('@')) {
      return 'Invalid email address'
    }
    if (password.length < 8) {
      return 'Password must be at least 8 characters'
    }
    if (password !== confirmPassword) {
      return 'Passwords do not match'
    }
    if (!usernameAvailable) {
      return 'Username is not available'
    }
    if (!emailAvailable) {
      return 'Email is already registered'
    }
    return null
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const validationError = validateForm()
    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)

    try {
      await signup(username, email, password)
      setSuccess(true)
      setTimeout(() => {
        navigate('/login')
      }, 2000)
    } catch (err: any) {
      setError(err.message || 'Signup failed')
    } finally {
      setLoading(false)
    }
  }

  // Scroll focused input into view on mobile virtual keyboard
  useEffect(() => {
    if (!focused) return
    const scrollFocusedInput = () => {
      formRef.current?.querySelector(`#${focused}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }
    const timers = [100, 350, 650].map((delay) => setTimeout(scrollFocusedInput, delay))
    window.visualViewport?.addEventListener('resize', scrollFocusedInput)

    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      window.visualViewport?.removeEventListener('resize', scrollFocusedInput)
    }
  }, [focused])

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
          <p className={styles.logoSubtitle}>Join the loom</p>
        </motion.div>

        {/* Card */}
        <motion.div
          className={styles.card}
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={styles.cardHighlight} />

          {success ? (
            <div className={styles.form}>
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
                className={styles.field}
              >
                <div style={{ textAlign: 'center', color: 'var(--lumiverse-success, #10b981)', fontSize: 'calc(14px * var(--lumiverse-font-scale, 1))' }}>
                  ✓ Account created successfully!
                </div>
                <div style={{ textAlign: 'center', color: 'var(--lumiverse-text-hint)', fontSize: 'calc(13px * var(--lumiverse-font-scale, 1))', marginTop: '8px' }}>
                  Redirecting to login...
                </div>
              </motion.div>
            </div>
          ) : (
            <form ref={formRef} className={styles.form} onSubmit={handleSubmit}>
              <motion.div
                className={styles.field}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.3 }}
              >
                <label className={styles.label} htmlFor="username">Username</label>
                <div className={clsx(styles.inputWrap, focused === 'username' && styles.inputWrapFocused)}>
                  <input
                    id="username"
                    name="username"
                    className={styles.input}
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onFocus={() => setFocused('username')}
                    onBlur={() => setFocused(null)}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoFocus
                    spellCheck={false}
                    enterKeyHint="next"
                    placeholder="3-32 alphanumeric and underscores"
                  />
                </div>
                {checkingUsername && <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-hint)' }}>Checking...</div>}
                {usernameAvailable === false && !checkingUsername && <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-danger, #ef4444)' }}>Username not available</div>}
                {usernameAvailable === true && !checkingUsername && <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-success, #10b981)' }}>Available</div>}
              </motion.div>

              <motion.div
                className={styles.field}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.35 }}
              >
                <label className={styles.label} htmlFor="email">Email</label>
                <div className={clsx(styles.inputWrap, focused === 'email' && styles.inputWrapFocused)}>
                  <input
                    id="email"
                    name="email"
                    className={styles.input}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onFocus={() => setFocused('email')}
                    onBlur={() => setFocused(null)}
                    autoComplete="email"
                    autoCapitalize="none"
                    enterKeyHint="next"
                    placeholder="your@email.com"
                  />
                </div>
                {checkingEmail && <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-hint)' }}>Checking...</div>}
                {emailAvailable === false && !checkingEmail && <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-danger, #ef4444)' }}>Email already registered</div>}
                {emailAvailable === true && !checkingEmail && <div style={{ fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-success, #10b981)' }}>Available</div>}
              </motion.div>

              <motion.div
                className={styles.field}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.4 }}
              >
                <label className={styles.label} htmlFor="password">Password</label>
                <div className={clsx(styles.inputWrap, focused === 'password' && styles.inputWrapFocused)}>
                  <input
                    id="password"
                    name="password"
                    className={styles.input}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocused('password')}
                    onBlur={() => setFocused(null)}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    enterKeyHint="next"
                    placeholder="At least 8 characters"
                  />
                </div>
              </motion.div>

              <motion.div
                className={styles.field}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.45 }}
              >
                <label className={styles.label} htmlFor="confirmPassword">Confirm Password</label>
                <div className={clsx(styles.inputWrap, focused === 'confirmPassword' && styles.inputWrapFocused)}>
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    className={styles.input}
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onFocus={() => setFocused('confirmPassword')}
                    onBlur={() => setFocused(null)}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    enterKeyHint="done"
                    placeholder="Confirm your password"
                  />
                </div>
              </motion.div>

              {error && (
                <motion.div
                  className={styles.error}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  transition={{ duration: 0.2 }}
                >
                  <div className={styles.errorInner}>{error}</div>
                </motion.div>
              )}

              <motion.button
                type="submit"
                className={styles.submitBtn}
                disabled={loading || !username || !email || !password || !confirmPassword || !usernameAvailable || !emailAvailable}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.5 }}
                whileHover={{ scale: 1.015 }}
                whileTap={{ scale: 0.985 }}
              >
                {loading ? (
                  <span className={styles.loadingState}>
                    <span className={styles.spinner} />
                    Creating account
                  </span>
                ) : (
                  'Create Account'
                )}
              </motion.button>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.6 }}
                style={{ textAlign: 'center', marginTop: '12px' }}
              >
                <p style={{ fontSize: 'calc(13px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-hint)', margin: 0 }}>
                  Already have an account?{' '}
                  <a href="/login" style={{ color: 'var(--lumiverse-primary-500)', textDecoration: 'none' }}>
                    Sign in
                  </a>
                </p>
              </motion.div>
            </form>
          )}
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
