import { useCallback, useMemo, useState } from 'react'
import { Activity, ExternalLink, RefreshCw, CircleCheck, CircleX, Clock3 } from 'lucide-react'
import { useStore } from '@/store'
import { connectionsApi } from '@/api/connections'
import styles from './StatusPanel.module.css'

type Check = { ok: boolean; message: string; checkedAt: number }

/** Connection health at a glance. Results are intentionally on-demand so this
 * panel never sends API keys or probes providers in the background. */
export default function StatusPanel() {
  const profiles = useStore((s) => s.profiles)
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [checking, setChecking] = useState(false)
  const statusProfiles = useMemo(
    () => profiles.filter((profile) => profile.provider !== 'model_roulette'),
    [profiles],
  )

  const runChecks = useCallback(async () => {
    setChecking(true)
    const results = await Promise.all(statusProfiles.map(async (profile) => {
      try {
        const result = await connectionsApi.test(profile.id)
        return [profile.id, { ok: result.success, message: result.message, checkedAt: Date.now() }] as const
      } catch (error) {
        return [profile.id, { ok: false, message: error instanceof Error ? error.message : 'Health check failed', checkedAt: Date.now() }] as const
      }
    }))
    setChecks(Object.fromEntries(results))
    setChecking(false)
  }, [statusProfiles])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div><Activity size={16} /><span>Provider Status</span></div>
        <button type="button" onClick={runChecks} disabled={checking || statusProfiles.length === 0}>
          <RefreshCw size={13} className={checking ? styles.spinning : undefined} /> {checking ? 'Checking…' : 'Check connections'}
        </button>
      </div>
      <p className={styles.help}>Run an on-demand connection check, or open each provider’s public status page. Checks never run automatically.</p>
      {statusProfiles.length === 0 ? <div className={styles.empty}>Add a connection to monitor its health.</div> : (
        <div className={styles.list}>{statusProfiles.map((profile) => {
          const check = checks[profile.id]
          const statusUrl = typeof profile.metadata?.status_url === 'string' ? profile.metadata.status_url : null
          return <div className={styles.row} key={profile.id}>
            {check ? check.ok ? <CircleCheck className={styles.ok} size={17} /> : <CircleX className={styles.bad} size={17} /> : <Clock3 className={styles.pending} size={17} />}
            <div className={styles.info}><strong>{profile.name}</strong><span>{profile.provider} · {check?.message || 'Not checked yet'}</span></div>
            {statusUrl && <a href={statusUrl} target="_blank" rel="noreferrer" title="Open provider status page"><ExternalLink size={15} /></a>}
          </div>
        })}</div>
      )}
    </div>
  )
}
