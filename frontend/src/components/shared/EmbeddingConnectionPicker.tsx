import { useEffect, useState } from 'react'
import { embeddingsApi, type EmbeddingConnectionProfile } from '@/api/embeddings'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import styles from './SidecarConnectionPicker.module.css'
import formStyles from './FormComponents.module.css'

interface Props {
  label: string
  ariaLabel?: string
  profiles: EmbeddingConnectionProfile[]
  connectionProfileId: string | null
  model: string | null
  onConnectionChange: (id: string | null) => void
  onModelChange: (model: string | null) => void
  onRemove?: () => void
  disabled?: boolean
  testId?: string
}

export default function EmbeddingConnectionPicker({
  label,
  ariaLabel,
  profiles,
  connectionProfileId,
  model,
  onConnectionChange,
  onModelChange,
  onRemove,
  disabled,
  testId,
}: Props) {
  const [models, setModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const selected = profiles.find((profile) => profile.id === connectionProfileId)

  useEffect(() => {
    setModels([])
    setModelLabels({})
  }, [connectionProfileId])

  const refresh = async () => {
    if (!connectionProfileId) return
    setLoading(true)
    try {
      const result = await embeddingsApi.previewModels({ profile_id: connectionProfileId })
      setModels(result.models || [])
      setModelLabels(result.model_labels || {})
    } catch {
      setModels([])
      setModelLabels({})
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.pickerStack} data-testid={testId}>
      <div className={styles.pickerHeader}>
        <span className={styles.pickerLabel}>{label}</span>
        {onRemove && (
          <button type="button" className={styles.tagRemove} onClick={onRemove} aria-label="Remove fallback">&times;</button>
        )}
      </div>
      <div className={styles.pickerControl}>
        <select
          className={formStyles.select}
          value={connectionProfileId || ''}
          onChange={(event) => {
            const id = event.target.value || null
            onConnectionChange(id)
            const profile = profiles.find((entry) => entry.id === id)
            if (profile) onModelChange(profile.model || null)
          }}
          aria-label={ariaLabel || label}
          disabled={disabled}
        >
          <option value="">Select an embedding connection…</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name || profile.provider}{profile.model ? ` — ${profile.model}` : ''}
            </option>
          ))}
        </select>
        {selected && (
          <ModelCombobox
            value={model || selected.model || ''}
            onChange={(value) => onModelChange(value || null)}
            models={models}
            modelLabels={modelLabels}
            loading={loading}
            onRefresh={refresh}
            autoRefreshOnFocus
            refreshKey={selected.id}
            appearance="standard"
            placeholder="Embedding model ID"
            emptyMessage="No embedding models returned"
            disabled={disabled}
          />
        )}
      </div>
      {profiles.length === 0 && (
        <p className={styles.pickerHint}>Add an Embedding Models connection in the Connections tab first.</p>
      )}
    </div>
  )
}
