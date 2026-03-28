import { useState, useEffect, useCallback } from 'react'
import { Folder, ArrowUp, ChevronRight } from 'lucide-react'
import { stMigrationApi, type BrowseResult } from '@/api/st-migration'
import styles from './DirectoryBrowser.module.css'

interface DirectoryBrowserProps {
  onNavigate?: (path: string) => void
  initialPath?: string
}

export default function DirectoryBrowser({ onNavigate, initialPath }: DirectoryBrowserProps) {
  const [data, setData] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')

  const navigate = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await stMigrationApi.browse(path)
      setData(result)
      setManualPath(result.path)
      onNavigate?.(result.path)
    } catch (err: any) {
      setError(err?.message || 'Failed to browse directory')
    } finally {
      setLoading(false)
    }
  }, [onNavigate])

  useEffect(() => {
    navigate(initialPath)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleManualSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && manualPath.trim()) {
      navigate(manualPath.trim())
    }
  }

  const pathSegments = data?.path ? data.path.split('/').filter(Boolean) : []

  return (
    <div className={styles.container}>
      <div className={styles.breadcrumbs}>
        <button type="button" className={styles.breadcrumbBtn} onClick={() => navigate('/')}>
          /
        </button>
        {pathSegments.map((segment, i) => {
          const segmentPath = '/' + pathSegments.slice(0, i + 1).join('/')
          return (
            <span key={segmentPath} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span className={styles.breadcrumbSep}><ChevronRight size={10} /></span>
              <button type="button" className={styles.breadcrumbBtn} onClick={() => navigate(segmentPath)}>
                {segment}
              </button>
            </span>
          )
        })}
      </div>

      <div className={styles.list}>
        {loading ? (
          <div className={styles.loading}>Loading...</div>
        ) : error ? (
          <div className={styles.error}>{error}</div>
        ) : (
          <>
            {data?.parent && (
              <button type="button" className={styles.entryUp} onClick={() => navigate(data.parent!)}>
                <ArrowUp size={14} className={styles.entryIcon} />
                ..
              </button>
            )}
            {data?.entries.length === 0 && !data?.parent && (
              <div className={styles.empty}>No directories found</div>
            )}
            {data?.entries.length === 0 && data?.parent && (
              <div className={styles.empty}>Empty directory</div>
            )}
            {data?.entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className={styles.entry}
                onClick={() => navigate(data.path === '/' ? `/${entry.name}` : `${data.path}/${entry.name}`)}
              >
                <Folder size={14} className={styles.entryIcon} />
                {entry.name}
              </button>
            ))}
          </>
        )}
      </div>

      <div className={styles.pathInput}>
        <input
          type="text"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={handleManualSubmit}
          placeholder="Enter path and press Enter"
        />
      </div>
    </div>
  )
}
