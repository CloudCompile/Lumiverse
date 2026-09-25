import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCheck, ChevronDown, X } from 'lucide-react'
import clsx from 'clsx'
import { useStore } from '@/store'
import { cardCreatorApi, type CardCreatorProposal } from '@/api/card-creator'
import ProposalDiff from '@/components/panels/card-agent/ProposalDiff'
import styles from './MessageCardCreatorProposals.module.css'

/**
 * Inline review cards for the edits a Card Creator turn proposed.
 *
 * The assistant message carries the proposal ids it filed in `extra`; this
 * component fetches those rows (so it survives a reload, when the ids — not
 * the proposal bodies — are all the message has) and renders an approve/reject
 * card for each. Approving is what actually writes the card.
 */
export default function MessageCardCreatorProposals({
  chatId,
  proposalIds,
}: {
  chatId: string
  proposalIds: number[]
}) {
  const cached = useStore((s) => s.cardCreatorProposals[chatId])
  const load = useStore((s) => s.loadCardCreatorProposals)

  // The chat's full queue is the source of truth so a proposal resolved in one
  // turn disappears from every turn that referenced it.
  const key = proposalIds.join(',')
  useEffect(() => {
    if (!cached) void load(chatId)
  }, [cached, chatId, key, load])

  if (!cached) return null

  const ids = new Set(proposalIds)
  const proposals = cached.filter((p) => ids.has(p.id) && p.status === 'pending')
  if (proposals.length === 0) return null

  return (
    <div className={styles.wrap}>
      <div className={styles.heading}>
        {proposals.length} proposed edit{proposals.length === 1 ? '' : 's'} — review before applying
      </div>
      {proposals.map((proposal) => (
        <InlineProposal key={proposal.id} chatId={chatId} proposal={proposal} />
      ))}
    </div>
  )
}

function InlineProposal({ chatId, proposal }: { chatId: string; proposal: CardCreatorProposal }) {
  const apply = useStore((s) => s.applyCardCreatorProposal)
  const reject = useStore((s) => s.rejectCardCreatorProposal)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<'apply' | 'reject' | null>(null)

  // The list row carries ids only; fetch the diff lazily the first time the
  // card is shown so a long conversation does not issue a request per proposal.
  const [diff, setDiff] = useState(proposal.diff)
  useEffect(() => {
    if (diff) return
    let cancelled = false
    cardCreatorApi
      .getProposal(proposal.id)
      .then((full) => {
        if (!cancelled) setDiff(full.diff)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [diff, proposal.id])

  const fields = diff?.fields.filter((f) => f.changed) ?? []
  const stale = diff?.stale ?? false

  const handle = async (kind: 'apply' | 'reject') => {
    setBusy(kind)
    try {
      if (kind === 'apply') await apply(chatId, proposal.id)
      else await reject(chatId, proposal.id)
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
          <AlertTriangle size={12} /> This card changed since the edit was proposed — ask the creator to redo it.
        </div>
      )}

      {fields.length > 0 && (
        <>
          <button type="button" className={styles.expandBtn} onClick={() => setExpanded((v) => !v)}>
            <ChevronDown size={12} className={clsx(styles.chevron, expanded && styles.chevronOpen)} />
            {expanded ? 'Hide changes' : 'Show changes'}
          </button>
          {expanded && <ProposalDiff fields={fields} />}
        </>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.applyBtn}
          disabled={busy !== null || stale}
          onClick={() => handle('apply')}
        >
          <CheckCheck size={12} /> {busy === 'apply' ? 'Applying…' : 'Approve'}
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
