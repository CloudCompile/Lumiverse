import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  CheckCircle, XCircle, KeyRound, RefreshCw, Copy, Trash2, Power, Tag,
  ExternalLink, Search, ChevronRight,
} from 'lucide-react'
import { Toggle } from '@/components/shared/Toggle'
import { Spinner } from '@/components/shared/Spinner'
import { useStore } from '@/store'
import {
  janitorBridgeApi,
  type JanitorBridgeConfig,
  type BridgeStats,
  type CapturedCard,
} from '@/api/janitor-bridge'
import styles from './JanitorBridgeSettings.module.css'

const DEFAULT_API_BASE = 'https://api.janitorai.com/v1'

export default function JanitorBridgeSettings() {
  const { t } = useTranslation('settings')
  const addToast = useStore((s) => s.addToast)

  const [config, setConfig] = useState<JanitorBridgeConfig | null>(null)
  const [stats, setStats] = useState<BridgeStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Local form state for the apiBase input (so we don't re-save on every keystroke)
  const [apiBaseDraft, setApiBaseDraft] = useState(DEFAULT_API_BASE)
  const [janitorApiKeyDraft, setJanitorApiKeyDraft] = useState('')
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [generatingKey, setGeneratingKey] = useState(false)
  const [savingJanitorKey, setSavingJanitorKey] = useState(false)

  // Captured cards gallery state
  const navigate = useNavigate()
  const [cards, setCards] = useState<CapturedCard[]>([])
  const [cardsTotal, setCardsTotal] = useState(0)
  const [cardsLoading, setCardsLoading] = useState(false)
  const [cardsSearch, setCardsSearch] = useState('')
  const [cardsTag, setCardsTag] = useState('')

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [cfg, st] = await Promise.all([
        janitorBridgeApi.getConfig(),
        janitorBridgeApi.getStats(),
      ])
      setConfig(cfg)
      setStats(st)
      setApiBaseDraft(cfg.apiBase || DEFAULT_API_BASE)
    } catch (err: any) {
      setError(err.message || 'Failed to load bridge config')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchCards = useCallback(async () => {
    setCardsLoading(true)
    try {
      const result = await janitorBridgeApi.listCards({
        limit: 50,
        offset: 0,
        search: cardsSearch || undefined,
        tag: cardsTag || undefined,
      })
      setCards(result.data)
      setCardsTotal(result.total)
    } catch (err: any) {
      // Don't surface as a top-level error — the cards section just shows empty.
      console.warn('[janitor-bridge] cards fetch failed:', err.message)
    } finally {
      setCardsLoading(false)
    }
  }, [cardsSearch, cardsTag])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  useEffect(() => {
    void fetchCards()
  }, [fetchCards])

  const handleDeleteCard = async (card: CapturedCard) => {
    if (!confirm(`Delete captured card "${card.name}"? This cannot be undone.`)) return
    try {
      await janitorBridgeApi.deleteCard(card.id)
      await fetchCards()
      addToast({ type: 'success', message: `Deleted "${card.name}"` })
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to delete' })
    }
  }

  const updateConfig = async (patch: Partial<JanitorBridgeConfig>) => {
    if (!config) return
    setSaving(true)
    try {
      const updated = await janitorBridgeApi.updateConfig(patch)
      setConfig(updated)
      addToast({ type: 'success', message: 'Settings saved' })
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to save' })
    } finally {
      setSaving(false)
    }
  }

  const handleGenerateKey = async () => {
    setGeneratingKey(true)
    try {
      const result = await janitorBridgeApi.generateBridgeKey()
      setGeneratedKey(result.key)
      await fetchAll()
      addToast({ type: 'success', message: 'New bridge key generated' })
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to generate key' })
    } finally {
      setGeneratingKey(false)
    }
  }

  const handleSaveJanitorKey = async () => {
    if (!janitorApiKeyDraft.trim()) {
      addToast({ type: 'warning', message: 'Enter an API key first' })
      return
    }
    setSavingJanitorKey(true)
    try {
      await janitorBridgeApi.setJanitorApiKey(janitorApiKeyDraft.trim())
      setJanitorApiKeyDraft('')
      await fetchAll()
      addToast({ type: 'success', message: 'Janitor AI API key saved (encrypted)' })
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to save API key' })
    } finally {
      setSavingJanitorKey(false)
    }
  }

  const handleClearJanitorKey = async () => {
    if (!confirm('Remove the stored Janitor AI API key? You will need to re-enter it to use the bridge.')) return
    try {
      await janitorBridgeApi.clearJanitorApiKey()
      await fetchAll()
      addToast({ type: 'info', message: 'Janitor API key removed' })
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to clear API key' })
    }
  }

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => addToast({ type: 'success', message: `${label} copied to clipboard` }),
      () => addToast({ type: 'error', message: 'Copy failed' }),
    )
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <Spinner />
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.warningText}>{error}</div>
        <button className={styles.btn} onClick={() => void fetchAll()}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    )
  }

  if (!config) return null

  const bridgeEndpoint = `${window.location.origin}/api/v1/janitor-bridge`
  const modelsEndpoint = `${bridgeEndpoint}/v1/models`

  // Readiness checklist: bridge is usable when enabled, has a key, and has the Janitor key set.
  const ready = config.enabled && config.hasBridgeKey && config.hasJanitorApiKey

  return (
    <div className={styles.container}>
      {/* ── Overview ─────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Power size={14} />
          Janitor Bridge
          <span
            className={`${styles.badge} ${
              ready ? styles.badgeOk : styles.badgeWarn
            }`}
            style={{ marginLeft: 'auto' }}
          >
            {ready ? (
              <>
                <CheckCircle size={11} /> Active
              </>
            ) : (
              <>
                <XCircle size={11} /> Not ready
              </>
            )}
          </span>
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.helperText}>
            The Janitor Bridge turns Lumiverse into a transparent capture proxy for
            Janitor AI chat traffic. Point your Janitor AI client at the bridge
            endpoint below, and every chat you have will automatically extract and
            save the character card to your Lumiverse library — while still
            forwarding the request to Janitor's real API and streaming the response
            back. No more manual card exports.
          </p>

          <div className={styles.statsGrid}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{stats?.totalCaptured ?? 0}</span>
              <span className={styles.statLabel}>Cards Captured</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{stats?.captureCount ?? 0}</span>
              <span className={styles.statLabel}>Total Captures</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>
                {stats?.lastCaptureAt
                  ? new Date(stats.lastCaptureAt * 1000).toLocaleDateString()
                  : '—'}
              </span>
              <span className={styles.statLabel}>Last Capture</span>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.rowLabel}>
              <span className={styles.rowTitle}>Enable bridge</span>
              <span className={styles.rowDescription}>
                When disabled, all bridge endpoints return 503 (Service Unavailable).
                Toggle off to pause capture without losing your config.
              </span>
            </div>
            <Toggle.Switch
              checked={config.enabled}
              onChange={(v) => void updateConfig({ enabled: v })}
              disabled={saving}
            />
          </div>

          <div className={styles.row}>
            <div className={styles.rowLabel}>
              <span className={styles.rowTitle}>
                <Tag size={12} style={{ display: 'inline', marginRight: 4 }} />
                Auto-tag captured cards
              </span>
              <span className={styles.rowDescription}>
                Run the 400-entry lexicon tag suggester on each new capture.
                Existing cards are not re-tagged.
              </span>
            </div>
            <Toggle.Switch
              checked={config.autoTag}
              onChange={(v) => void updateConfig({ autoTag: v })}
              disabled={saving}
            />
          </div>
        </div>
      </div>

      {/* ── Endpoint info ───────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <ExternalLink size={14} />
          Bridge Endpoint
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.helperText}>
            Enter this URL as the <strong>API base URL</strong> in your Janitor AI
            client settings (or SillyTavern's "Custom (OpenAI-compatible)" provider):
          </p>
          <div className={styles.endpointUrl}>{bridgeEndpoint}</div>
          <button
            className={styles.btn}
            onClick={() => handleCopy(bridgeEndpoint, 'Bridge endpoint URL')}
          >
            <Copy size={12} /> Copy URL
          </button>

          <p className={styles.helperText} style={{ marginTop: 8 }}>
            For clients that probe a <code>/v1/models</code> endpoint on connect,
            that lives at:
          </p>
          <div className={styles.endpointUrl}>{modelsEndpoint}</div>
        </div>
      </div>

      {/* ── Bridge key (auth from Janitor UI) ───────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <KeyRound size={14} />
          Bridge API Key
          <span
            className={`${styles.badge} ${
              config.hasBridgeKey ? styles.badgeOk : styles.badgeWarn
            }`}
            style={{ marginLeft: 'auto' }}
          >
            {config.hasBridgeKey ? 'Generated' : 'Not generated'}
          </span>
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.helperText}>
            This key is what your Janitor AI client sends as the{' '}
            <code>Authorization: Bearer</code> header. Generate one, then paste it
            into your Janitor AI client's API key field. The key is stored as a
            SHA-256 hash — if you lose it, generate a new one (which invalidates
            the old).
          </p>

          {generatedKey ? (
            <>
              <div className={styles.warningText}>
                Copy this key now — it will not be shown again.
              </div>
              <div className={styles.codeBlock}>{generatedKey}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className={styles.btn}
                  onClick={() => handleCopy(generatedKey, 'Bridge key')}
                >
                  <Copy size={12} /> Copy key
                </button>
                <button
                  className={styles.btn}
                  onClick={() => setGeneratedKey(null)}
                >
                  Dismiss
                </button>
              </div>
            </>
          ) : (
            <button
              className={styles.btn}
              onClick={() => void handleGenerateKey()}
              disabled={generatingKey}
            >
              {generatingKey ? (
                <>
                  <Spinner size={12} /> Generating…
                </>
              ) : (
                <>
                  <KeyRound size={12} /> {config.hasBridgeKey ? 'Generate new key' : 'Generate bridge key'}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* ── Janitor AI API key (stored encrypted) ────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <KeyRound size={14} />
          Janitor AI API Key
          <span
            className={`${styles.badge} ${
              config.hasJanitorApiKey ? styles.badgeOk : styles.badgeWarn
            }`}
            style={{ marginLeft: 'auto' }}
          >
            {config.hasJanitorApiKey ? 'Set (encrypted)' : 'Not set'}
          </span>
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.helperText}>
            Your real Janitor AI API key — the one Janitor AI's UI would normally
            use directly. The bridge stores it AES-256-GCM encrypted (via
            Lumiverse's secrets service) and substitutes it for the bridge key
            when forwarding requests to Janitor's real API. It never appears in
            logs and never leaves this Lumiverse process.
          </p>
          <p className={styles.helperText}>
            Get your key from{' '}
            <a
              href="https://janitorai.com/settings"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--lumiverse-primary)' }}
            >
              janitorai.com/settings
            </a>{' '}
            → API Key.
          </p>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              className={`${styles.input} ${styles.inputMono}`}
              placeholder={config.hasJanitorApiKey ? '•••••••••••••••• (set — enter new to replace)' : 'sk-...'}
              value={janitorApiKeyDraft}
              onChange={(e) => setJanitorApiKeyDraft(e.target.value)}
              autoComplete="off"
            />
            <button
              className={styles.btnPrimary + ' ' + styles.btn}
              onClick={() => void handleSaveJanitorKey()}
              disabled={savingJanitorKey || !janitorApiKeyDraft.trim()}
            >
              {savingJanitorKey ? <Spinner size={12} /> : null}
              Save
            </button>
            {config.hasJanitorApiKey && (
              <button
                className={styles.btnDanger + ' ' + styles.btn}
                onClick={() => void handleClearJanitorKey()}
                title="Remove stored key"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Upstream API base URL ───────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <ExternalLink size={14} />
          Janitor API Base URL
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.helperText}>
            The upstream URL the bridge forwards to. Defaults to Janitor AI's
            public OpenAI-compatible endpoint. Only change this if you know
            Janitor's URL has changed, or you're routing through a different
            OpenAI-compatible backend.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className={`${styles.input} ${styles.inputMono}`}
              value={apiBaseDraft}
              onChange={(e) => setApiBaseDraft(e.target.value)}
              placeholder={DEFAULT_API_BASE}
            />
            <button
              className={styles.btnPrimary + ' ' + styles.btn}
              onClick={() => void updateConfig({ apiBase: apiBaseDraft.trim() })}
              disabled={saving || !apiBaseDraft.trim() || apiBaseDraft.trim() === config.apiBase}
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {/* ── Setup walkthrough ───────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          How to use it
        </div>
        <div className={styles.sectionBody}>
          <ol className={styles.stepsList}>
            <li className={styles.stepItem}>
              <div className={styles.stepContent}>
                Generate a bridge key above (if you haven't already).
              </div>
            </li>
            <li className={styles.stepItem}>
              <div className={styles.stepContent}>
                Enter your real Janitor AI API key above (it gets encrypted at rest).
              </div>
            </li>
            <li className={styles.stepItem}>
              <div className={styles.stepContent}>
                In your Janitor AI client (or SillyTavern), set the API base URL to{' '}
                <span className={styles.codeInline}>{bridgeEndpoint}</span> and the
                API key to your bridge key.
              </div>
            </li>
            <li className={styles.stepItem}>
              <div className={styles.stepContent}>
                Enable the bridge toggle at the top of this page.
              </div>
            </li>
            <li className={styles.stepItem}>
              <div className={styles.stepContent}>
                Start chatting. Every chat will silently extract the character
                card and save it to your Lumiverse library. Captured cards
                appear in the gallery below — and also in the main Characters
                browser, where you can edit, fork, or chat with them natively.
              </div>
            </li>
          </ol>
        </div>
      </div>

      {/* ── Captured cards gallery ────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Tag size={14} />
          Captured Cards
          <span className={`${styles.badge} ${styles.badgeMuted}`} style={{ marginLeft: 'auto' }}>
            {cardsTotal} total
          </span>
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.helperText}>
            Every card the bridge has extracted. Click any card to open it in the
            character browser (where you can edit, fork, or start a chat). Cards
            are stored as first-class Lumiverse characters — they appear here
            because they were tagged with the <code>janitor_bridge</code> source.
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--lumiverse-text-muted)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                className={styles.input}
                placeholder="Search by name or description…"
                value={cardsSearch}
                onChange={(e) => setCardsSearch(e.target.value)}
                style={{ paddingLeft: 32 }}
              />
            </div>
            <input
              type="text"
              className={styles.input}
              placeholder="Filter by tag…"
              value={cardsTag}
              onChange={(e) => setCardsTag(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            <button
              className={styles.btn}
              onClick={() => void fetchCards()}
              disabled={cardsLoading}
              title="Refresh"
            >
              <RefreshCw size={12} className={cardsLoading ? 'spin' : ''} />
            </button>
          </div>

          {cardsLoading && cards.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <Spinner />
            </div>
          ) : cards.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--lumiverse-text-muted)',
                fontSize: 'calc(13px * var(--lumiverse-font-scale, 1))',
              }}
            >
              {cardsTotal === 0
                ? 'No cards captured yet. Once you start chatting through the bridge, captured cards will appear here.'
                : 'No cards match your search.'}
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 10,
              }}
            >
              {cards.map((card) => (
                <CapturedCardTile
                  key={card.id}
                  card={card}
                  onOpen={() => navigate(`/characters/${card.id}`)}
                  onDelete={() => void handleDeleteCard(card)}
                />
              ))}
            </div>
          )}

          {cardsTotal > cards.length && (
            <p className={styles.helperText} style={{ textAlign: 'center' }}>
              Showing {cards.length} of {cardsTotal}. Refine your search to see more.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Captured card tile ──────────────────────────────────────────────────────

function CapturedCardTile({
  card,
  onOpen,
  onDelete,
}: {
  card: CapturedCard
  onOpen: () => void
  onDelete: () => void
}) {
  const lastChat = card.last_chat_at
    ? new Date(card.last_chat_at * 1000).toLocaleDateString()
    : null

  return (
    <div
      style={{
        border: '1px solid var(--lumiverse-border)',
        borderRadius: 8,
        padding: 12,
        background: 'var(--lumiverse-fill)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        cursor: 'pointer',
        position: 'relative',
      }}
      onClick={onOpen}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          justifyContent: 'space-between',
        }}
      >
        <strong
          style={{
            fontSize: 'calc(13.5px * var(--lumiverse-font-scale, 1))',
            color: 'var(--lumiverse-text)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {card.name}
        </strong>
        <ChevronRight
          size={14}
          style={{
            color: 'var(--lumiverse-text-muted)',
            flexShrink: 0,
          }}
        />
      </div>

      <div
        style={{
          fontSize: 'calc(11.5px * var(--lumiverse-font-scale, 1))',
          color: 'var(--lumiverse-text-muted)',
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span>{card.chat_count} chat{card.chat_count === 1 ? '' : 's'}</span>
        {lastChat && <span>· last {lastChat}</span>}
      </div>

      {card.tags.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
            marginTop: 2,
          }}
        >
          {card.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className={`${styles.badge} ${styles.badgeMuted}`}
              style={{ fontSize: 'calc(10px * var(--lumiverse-font-scale, 1))' }}
            >
              {tag}
            </span>
          ))}
          {card.tags.length > 4 && (
            <span
              className={`${styles.badge} ${styles.badgeMuted}`}
              style={{ fontSize: 'calc(10px * var(--lumiverse-font-scale, 1))' }}
            >
              +{card.tags.length - 4}
            </span>
          )}
        </div>
      )}

      <button
        className={`${styles.btnDanger} ${styles.btn}`}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          padding: '4px 6px',
          fontSize: 'calc(10px * var(--lumiverse-font-scale, 1))',
          opacity: 0,
          transition: 'opacity 0.15s',
        }}
        onMouseOver={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseOut={(e) => (e.currentTarget.style.opacity = '0')}
        title="Delete captured card"
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}
