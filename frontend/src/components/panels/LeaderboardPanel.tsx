import { useEffect, useCallback, useState } from 'react'
import { Trophy, RotateCcw, ThumbsUp, ThumbsDown } from 'lucide-react'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import styles from './LeaderboardPanel.module.css'
import clsx from 'clsx'

function rankClass(index: number): string {
  if (index === 0) return styles.rankGold
  if (index === 1) return styles.rankSilver
  if (index === 2) return styles.rankBronze
  return styles.rankDefault
}

export default function LeaderboardPanel() {
  const entries = useStore((s) => s.leaderboardEntries)
  const loading = useStore((s) => s.leaderboardLoading)
  const loadLeaderboard = useStore((s) => s.loadLeaderboard)
  const resetLeaderboard = useStore((s) => s.resetLeaderboard)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    loadLeaderboard()
  }, [loadLeaderboard])

  const handleReset = useCallback(async () => {
    await resetLeaderboard()
    setConfirmReset(false)
  }, [resetLeaderboard])

  if (loading && entries.length === 0) {
    return <div className={styles.loading}>Loading leaderboard...</div>
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Trophy size={16} />
          <span>Model Leaderboard</span>
        </div>
        {entries.length > 0 && (
          <button
            type="button"
            className={styles.resetBtn}
            onClick={() => setConfirmReset(true)}
          >
            <RotateCcw size={12} />
            Reset
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className={styles.empty}>
          No ratings yet. Use the thumbs up/down buttons on AI messages to rate model responses.
        </div>
      ) : (
        <div className={styles.list}>
          {entries.map((entry, i) => (
            <div key={`${entry.provider}:${entry.model}`} className={styles.entry}>
              <div className={clsx(styles.rank, rankClass(i))}>
                {i + 1}
              </div>
              <div className={styles.entryInfo}>
                <div className={styles.modelName} title={entry.model}>
                  {entry.model}
                </div>
                <div className={styles.providerName}>
                  {entry.provider}
                </div>
              </div>
              <div className={styles.entryStats}>
                <div className={styles.elo}>{entry.elo}</div>
                <div className={styles.record}>
                  <span className={styles.wins}>
                    <ThumbsUp size={10} /> {entry.wins}
                  </span>
                  <span className={styles.losses}>
                    <ThumbsDown size={10} /> {entry.losses}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.hint}>
        Rate AI responses with thumbs up/down to build your model rankings.
        Models are scored using an Elo rating system.
      </div>

      {confirmReset && (
        <ConfirmationModal
          title="Reset Leaderboard"
          message="This will clear all model ratings and vote history. This cannot be undone."
          isOpen={true}
          variant="danger"
          confirmText="Reset"
          onConfirm={handleReset}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  )
}
