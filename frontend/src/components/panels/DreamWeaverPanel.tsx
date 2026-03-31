import { useCallback, useEffect, useId, useState } from 'react'
import { AlertCircle, Clock3, FolderOpen, History, Sparkles, Trash2 } from 'lucide-react'
import { dreamWeaverApi, type DreamWeaverDraft, type DreamWeaverSession } from '@/api/dream-weaver'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'
import styles from './DreamWeaverPanel.module.css'

function parseDraft(rawDraft: string | null): DreamWeaverDraft | null {
  if (!rawDraft) return null
  try {
    return JSON.parse(rawDraft) as DreamWeaverDraft
  } catch {
    return null
  }
}

function sessionTitle(session: DreamWeaverSession): string {
  const draft = parseDraft(session.draft)
  return draft?.card?.name || draft?.meta?.title || 'Untitled weave'
}

function sessionPreview(session: DreamWeaverSession): string {
  const draft = parseDraft(session.draft)
  return draft?.meta?.summary || session.dream_text
}

function sessionStatus(session: DreamWeaverSession): string {
  if (session.character_id) return 'Finalized'
  if (session.status === 'complete') return 'Draft ready'
  if (session.status === 'generating') return 'Weaving'
  if (session.status === 'error') return 'Needs attention'
  return 'Saved'
}

export default function DreamWeaverPanel() {
  const [dreamText, setDreamText] = useState('')
  const [sessions, setSessions] = useState<DreamWeaverSession[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [sessionToDelete, setSessionToDelete] = useState<DreamWeaverSession | null>(null)

  const dreamId = useId()

  const openModal = useStore((s) => s.openModal)
  const activeModal = useStore((s) => s.activeModal)

  const loadSessions = useCallback(async () => {
    setIsLoadingSessions(true)
    try {
      const nextSessions = await dreamWeaverApi.getSessions()
      setSessions(nextSessions)
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Failed to load Dream Weaver sessions'
      toast.error(message, { title: 'Dream Weaver' })
    } finally {
      setIsLoadingSessions(false)
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (activeModal !== 'dreamWeaverStudio') {
      void loadSessions()
    }
  }, [activeModal, loadSessions])

  const handleWeave = async () => {
    if (!dreamText.trim()) return

    setIsCreating(true)
    setErrorMessage(null)

    try {
      const session = await dreamWeaverApi.createSession({
        dream_text: dreamText,
      })

      try {
        await dreamWeaverApi.generateDraft(session.id)
      } catch (error: any) {
        const message = error?.body?.error || error?.message || 'Dream weaving failed'
        const recoveryMessage = `${message}. The session was saved in Previous Weaves so you can reopen it later.`
        setErrorMessage(recoveryMessage)
        toast.error(recoveryMessage, { title: 'Dream Weaver' })
        return
      }

      setDreamText('')
      openModal('dreamWeaverStudio', { sessionId: session.id })
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Failed to create Dream Weaver session'
      setErrorMessage(message)
      toast.error(message, { title: 'Dream Weaver' })
    } finally {
      void loadSessions()
      setIsCreating(false)
    }
  }

  const handleOpenSession = (sessionId: string) => {
    openModal('dreamWeaverStudio', { sessionId })
  }

  const handleDeleteSession = async () => {
    if (!sessionToDelete) return

    try {
      await dreamWeaverApi.deleteSession(sessionToDelete.id)
      setSessions((current) => current.filter((session) => session.id !== sessionToDelete.id))
      toast.success('Dream Weaver session deleted', { title: 'Dream Weaver' })
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Failed to delete Dream Weaver session'
      toast.error(message, { title: 'Dream Weaver' })
    } finally {
      setSessionToDelete(null)
    }
  }

  return (
    <>
      <div className={styles.wrapper}>
        <section className={styles.header}>
          <div className={styles.headerMain}>
            <div className={styles.iconBadge}>
              <Sparkles size={18} />
            </div>
            <div className={styles.headerCopy}>
              <h1 className={styles.headerTitle}>Dream Weaver</h1>
              <p className={styles.headerSubtitle}>Start with the core idea. Re-weave in the studio.</p>
            </div>
          </div>
        </section>

        <div className={styles.content}>
          <section className={styles.composeSection}>
          <div className={styles.fieldBlock}>
            <label className={styles.fieldLabel} htmlFor={dreamId}>
              Dream
            </label>
            <textarea
              id={dreamId}
              className={styles.mainTextarea}
              placeholder={
                "Describe the character, tension, history, and angle you want preserved."
              }
              value={dreamText}
              onChange={(event) => setDreamText(event.target.value)}
              rows={6}
            />
          </div>
          </section>

          {errorMessage && (
            <div className={styles.errorBox} role="alert">
              <AlertCircle size={16} />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className={styles.actionRow}>
            <button
              className={styles.weaveButton}
              onClick={handleWeave}
              disabled={!dreamText.trim() || isCreating}
            >
              <Sparkles size={18} />
              {isCreating ? 'Weaving...' : 'Weave Dream'}
            </button>
          </div>

          <section className={styles.sessionsSection}>
            <div className={styles.sessionsHeader}>
              <History size={16} />
              <div className={styles.sessionsHeaderCopy}>
                <h2 className={styles.sectionTitle}>Previous Weaves</h2>
              </div>
            </div>

            {isLoadingSessions ? (
              <div className={styles.sessionsEmpty}>Loading saved weaves...</div>
            ) : sessions.length === 0 ? (
              <div className={styles.sessionsEmpty}>No saved weaves yet.</div>
            ) : (
              <div className={styles.sessionsList}>
                {sessions.map((session) => (
                  <article
                    key={session.id}
                    className={styles.sessionCard}
                    onClick={() => handleOpenSession(session.id)}
                  >
                    <div className={styles.sessionTopRow}>
                      <div className={styles.sessionHeading}>
                        <h3 className={styles.sessionTitle}>{sessionTitle(session)}</h3>
                        <span className={styles.sessionStatus}>{sessionStatus(session)}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.deleteButton}
                        onClick={(event) => {
                          event.stopPropagation()
                          setSessionToDelete(session)
                        }}
                        aria-label="Delete session"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <p className={styles.sessionPreview}>{sessionPreview(session)}</p>

                    <div className={styles.sessionMeta}>
                      <span className={styles.sessionMetaItem}>
                        <Clock3 size={12} />
                        {new Date(session.updated_at * 1000).toLocaleString()}
                      </span>
                      {session.tone && <span className={styles.sessionMetaItem}>{session.tone}</span>}
                    </div>

                    <div className={styles.sessionActions}>
                      <button
                        type="button"
                        className={styles.resumeButton}
                        onClick={(event) => {
                          event.stopPropagation()
                          handleOpenSession(session.id)
                        }}
                      >
                        <FolderOpen size={14} />
                        Open Session
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      {sessionToDelete && (
        <ConfirmationModal
          isOpen={true}
          title="Delete this session?"
          message="This removes the saved weave state. The generated character stays if you already finalized it."
          variant="warning"
          confirmText="Delete session"
          onConfirm={() => void handleDeleteSession()}
          onCancel={() => setSessionToDelete(null)}
        />
      )}
    </>
  )
}
