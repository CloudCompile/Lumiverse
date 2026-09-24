import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CheckCheck,
  Plus,
  Send,
  Trash2,
  Wrench,
  X,
  AlertTriangle,
  History,
} from 'lucide-react'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { EditProposal, ToolActivity } from '@/api/card-agent'
import ProposalDiff from './ProposalDiff'
import { relativeTime } from './format'
import styles from './CardAgentPanel.module.css'

/**
 * Card Agent: a conversational pane over the character library.
 *
 * Two things share this surface — the conversation, and the review queue of
 * edits the agent has proposed. The agent cannot write; approving here is what
 * actually changes a card.
 */

function ToolRow({ activity }: { activity: ToolActivity }) {
  return (
    <div className={clsx(styles.toolRow, !activity.ok && styles.toolRowError)}>
      <Wrench size={11} />
      <span className={styles.toolName}>{activity.name}</span>
      <span className={styles.toolSummary}>{activity.summary}</span>
    </div>
  )
}

function ProposalCard({ proposal }: { proposal: EditProposal }) {
  const applyProposal = useStore((s) => s.applyCardAgentProposal)
  const rejectProposal = useStore((s) => s.rejectCardAgentProposal)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<'apply' | 'reject' | null>(null)

  const fields = proposal.diff?.fields.filter((f) => f.changed) ?? []
  const stale = proposal.diff?.stale ?? false

  const handle = async (kind: 'apply' | 'reject') => {
    setBusy(kind)
    try {
      if (kind === 'apply') await applyProposal(proposal.id)
      else await rejectProposal(proposal.id)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={clsx(styles.proposal, stale && styles.proposalStale)}>
      <div className={styles.proposalHead}>
        <span className={styles.proposalName}>{proposal.character_name}</span>
        <span className={styles.proposalCount}>
          {fields.length} field{fields.length === 1 ? '' : 's'}
        </span>
      </div>

      {proposal.rationale && <div className={styles.proposalRationale}>{proposal.rationale}</div>}

      {stale && (
        <div className={styles.staleNote}>
          <AlertTriangle size={12} /> This card changed since the edit was proposed — ask the agent to redo it.
        </div>
      )}

      <button type="button" className={styles.expandBtn} onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'Hide changes' : 'Show changes'}
      </button>

      {expanded && <ProposalDiff fields={fields} />}

      <div className={styles.proposalActions}>
        <button
          type="button"
          className={styles.applyBtn}
          disabled={busy !== null || stale}
          onClick={() => handle('apply')}
        >
          <CheckCheck size={12} /> {busy === 'apply' ? 'Applying…' : 'Apply'}
        </button>
        <button
          type="button"
          className={styles.rejectBtn}
          disabled={busy !== null}
          onClick={() => handle('reject')}
        >
          <X size={12} /> Reject
        </button>
      </div>
    </div>
  )
}

export default function CardAgentPanel() {
  const sessions = useStore((s) => s.cardAgentSessions)
  const activeSessionId = useStore((s) => s.cardAgentActiveSessionId)
  const messages = useStore((s) => s.cardAgentMessages)
  const proposals = useStore((s) => s.cardAgentProposals)
  const busy = useStore((s) => s.cardAgentBusy)
  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)

  const loadSessions = useStore((s) => s.loadCardAgentSessions)
  const createSession = useStore((s) => s.createCardAgentSession)
  const selectSession = useStore((s) => s.selectCardAgentSession)
  const deleteSession = useStore((s) => s.deleteCardAgentSession)
  const sendTurn = useStore((s) => s.sendCardAgentTurn)
  const applyBatch = useStore((s) => s.applyCardAgentProposalBatch)
  const loadProposals = useStore((s) => s.loadCardAgentProposals)

  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadSessions()
    loadProposals()
  }, [loadSessions, loadProposals])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages.length, busy])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )

  const handleNew = async () => {
    const preferred = activeProfileId ?? profiles[0]?.id ?? null
    if (!preferred) return
    try {
      const session = await createSession({
        title: 'New session',
        connectionId: preferred,
        model: profiles.find((p) => p.id === preferred)?.model ?? null,
      })
      await selectSession(session.id)
    } catch {
      // The store surfaces the failure; nothing more to do here.
    }
  }

  const handleSend = async () => {
    if (!draft.trim() || busy) return
    const text = draft
    setDraft('')
    await sendTurn(text)
  }

  return (
    <div className={styles.panel}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <span>Sessions</span>
          <button
            type="button"
            className={styles.iconBtn}
            title="New session"
            onClick={handleNew}
            disabled={profiles.length === 0}
          >
            <Plus size={13} />
          </button>
        </div>
        <div className={styles.sessionList}>
          {sessions.length === 0 && <div className={styles.emptySide}>No sessions yet.</div>}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={clsx(styles.sessionRow, session.id === activeSessionId && styles.sessionRowActive)}
            >
              <button
                type="button"
                className={styles.sessionBtn}
                onClick={() => selectSession(session.id)}
              >
                <Bot size={12} />
                <span className={styles.sessionTitle}>{session.title}</span>
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                title="Delete session"
                onClick={() => deleteSession(session.id)}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className={styles.main}>
        {!activeSession ? (
          <div className={styles.empty}>
            {profiles.length === 0
              ? 'Add a connection profile first — the agent needs a model to talk to.'
              : 'Start a session to have the agent read your cards and propose edits.'}
          </div>
        ) : (
          <>
            <div className={styles.transcript} ref={scrollRef}>
              {messages.length === 0 && (
                <div className={styles.emptyTranscript}>
                  Ask about your library, or name a card and what you want changed.
                  <br />
                  The agent reads cards and files proposals — nothing changes until you approve it.
                </div>
              )}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={clsx(styles.bubble, message.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant)}
                >
                  {message.tool_activity.length > 0 && (
                    <div className={styles.toolList}>
                      {message.tool_activity.map((activity, i) => (
                        <ToolRow key={`${activity.name}-${i}`} activity={activity} />
                      ))}
                    </div>
                  )}
                  <div className={styles.bubbleText}>{message.content}</div>
                </div>
              ))}
              {busy && <div className={styles.thinking}>Working…</div>}
            </div>

            <div className={styles.composer}>
              <textarea
                className={styles.input}
                value={draft}
                placeholder="e.g. Find my sci-fi cards and tighten any description that reads generic"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                rows={2}
              />
              <button
                type="button"
                className={styles.sendBtn}
                onClick={handleSend}
                disabled={busy || !draft.trim()}
              >
                <Send size={14} />
              </button>
            </div>
          </>
        )}
      </main>

      <aside className={styles.review}>
        <div className={styles.sidebarHead}>
          <span>
            <History size={12} /> Pending edits
          </span>
          {proposals.length > 0 && (
            <button
              type="button"
              className={styles.batchBtn}
              onClick={() => applyBatch(activeSessionId ? { sessionId: activeSessionId } : {})}
            >
              Apply all
            </button>
          )}
        </div>
        <div className={styles.proposalList}>
          {proposals.length === 0 ? (
            <div className={styles.emptySide}>No proposed edits.</div>
          ) : (
            proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)
          )}
        </div>
      </aside>
    </div>
  )
}
