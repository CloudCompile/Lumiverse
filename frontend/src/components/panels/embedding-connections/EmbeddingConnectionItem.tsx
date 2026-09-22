import { useEffect, useState } from 'react'
import { Edit3, Trash2, Zap } from 'lucide-react'
import clsx from 'clsx'
import ProviderIcon from '@/components/shared/ProviderIcon'
import { embeddingsApi, type EmbeddingConnectionProfile, type EmbeddingDriverOption } from '@/api/embeddings'
import EmbeddingConnectionForm, { type EmbeddingConnectionDraft } from './EmbeddingConnectionForm'
import styles from '../connection-manager/ConnectionItem.module.css'

interface Props {
  profile: EmbeddingConnectionProfile
  providers: EmbeddingDriverOption[]
  onUpdate: (profile: EmbeddingConnectionDraft) => Promise<boolean>
  onDelete: () => void
  disabled?: boolean
}

export default function EmbeddingConnectionItem({ profile, providers, onUpdate, onDelete, disabled }: Props) {
  const [editing, setEditing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!testResult) return
    const timer = setTimeout(() => setTestResult(null), 5000)
    return () => clearTimeout(timer)
  }, [testResult])

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await embeddingsApi.testConnection(profile.id)
      setTestResult({ success: result.success, message: result.dimension ? `Connection successful (${result.dimension} dimensions)` : result.message })
    } catch (err: any) {
      setTestResult({ success: false, message: err?.body?.message || err?.message || 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={styles.item}>
      {editing ? (
        <EmbeddingConnectionForm
          providers={providers}
          profile={profile}
          onSave={async (next) => { if (await onUpdate(next)) setEditing(false) }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className={styles.itemRow}>
            <div className={styles.itemBtn} style={{ cursor: 'default' }}>
              <ProviderIcon kind="embedding" provider={profile.provider} size={32} iconSize={16} className={styles.itemIcon} />
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{profile.name || profile.provider}</span>
                <span className={styles.itemMeta}>
                  {profile.provider} / {profile.model}{profile.dimensions ? ` / ${profile.dimensions}d` : ''}
                </span>
              </div>
            </div>
            <div className={styles.itemActions}>
              <button type="button" className={clsx(styles.actionBtn, testResult?.success && styles.testSuccess, testResult && !testResult.success && styles.testFail)} onClick={test} disabled={testing} title="Test connection">
                <Zap size={13} />
              </button>
              <button type="button" className={styles.actionBtn} onClick={() => setEditing(true)} disabled={disabled} title="Edit">
                <Edit3 size={13} />
              </button>
              <button type="button" className={styles.actionBtn} onClick={onDelete} disabled={disabled} title="Delete">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {testResult && (
            <div className={clsx(styles.testMessage, testResult.success ? styles.testMessageSuccess : styles.testMessageFail)}>
              {testResult.message}
            </div>
          )}
        </>
      )}
    </div>
  )
}
