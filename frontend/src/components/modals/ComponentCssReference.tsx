import { Paintbrush, FileCode2 } from 'lucide-react'
import styles from './PropsReference.module.css'

interface ComponentCssReferenceProps {
  componentName: string
  cssContent: string
}

export default function ComponentCssReference({ componentName, cssContent }: ComponentCssReferenceProps) {
  // Extract CSS class names (e.g. .card, .user, .avatarBg)
  const classMatches = Array.from(cssContent.matchAll(/\.([a-zA-Z0-9_-]+)/g))
  const uniqueClasses = Array.from(new Set(classMatches.map(m => m[1])))

  // Extract local component variables (e.g. --lcs-radius, --lcs-glass-bg)
  const varMatches = Array.from(cssContent.matchAll(/(--[a-zA-Z0-9_-]+)/g))
  const uniqueVars = Array.from(new Set(varMatches.map(m => m[1])))
    .filter(v => !v.startsWith('--lumiverse-')) // Filter out global vars we already expose

  if (uniqueClasses.length === 0 && uniqueVars.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>
            <FileCode2 size={13} />
            CSS Selectors
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.emptyNote}>
            No classes or variables found for {componentName}.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          <FileCode2 size={13} />
          CSS Context — {uniqueClasses.length + uniqueVars.length}
        </span>
      </div>
      <div className={styles.list}>
        {uniqueClasses.length > 0 && (
          <div className={styles.group}>
            <span className={styles.categoryTitle}>Available Classes</span>
            <div className={styles.classesContainer}>
              {uniqueClasses.map(cls => (
                <div key={cls} className={styles.propRow}>
                  <div className={styles.propHeader}>
                    <span className={styles.propName} style={{ paddingLeft: '8px' }}>.{cls}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {uniqueVars.length > 0 && (
          <div className={styles.group} style={{ marginTop: 12 }}>
            <span className={styles.categoryTitle}>Local Variables</span>
            <div className={styles.classesContainer}>
              {uniqueVars.map(v => (
                <div key={v} className={styles.propRow}>
                  <div className={styles.propHeader}>
                    <span className={styles.propType} style={{ color: 'var(--lumiverse-text)', paddingLeft: '8px' }}>{v}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
