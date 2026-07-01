import { useCallback } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { useStore } from '@/store'
import styles from './VoteButtons.module.css'
import clsx from 'clsx'

interface VoteButtonsProps {
  messageId: string
  swipeId: number
  chatId: string
  model: string | undefined
  provider: string | undefined
  connectionId?: string | null
}

export default function VoteButtons({
  messageId,
  swipeId,
  chatId,
  model,
  provider,
  connectionId,
}: VoteButtonsProps) {
  const leaderboardVotes = useStore((s) => s.leaderboardVotes)
  const castVote = useStore((s) => s.castLeaderboardVote)
  const removeVote = useStore((s) => s.removeLeaderboardVote)

  const key = `${messageId}:${swipeId}`
  const currentVote = leaderboardVotes[key] ?? 0

  const handleVote = useCallback(
    (vote: 1 | -1) => {
      if (!model || !provider) return
      if (currentVote === vote) {
        removeVote(messageId, swipeId)
      } else {
        castVote({ messageId, swipeId, chatId, model, provider, connectionId, vote })
      }
    },
    [messageId, swipeId, chatId, model, provider, connectionId, currentVote, castVote, removeVote],
  )

  if (!model || !provider) return null

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={clsx(styles.btnUp, currentVote === 1 && styles.btnUpActive)}
        onClick={() => handleVote(1)}
        title="Good response"
        aria-label="Thumbs up"
        aria-pressed={currentVote === 1}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        type="button"
        className={clsx(styles.btnDown, currentVote === -1 && styles.btnDownActive)}
        onClick={() => handleVote(-1)}
        title="Bad response"
        aria-label="Thumbs down"
        aria-pressed={currentVote === -1}
      >
        <ThumbsDown size={13} />
      </button>
    </span>
  )
}
