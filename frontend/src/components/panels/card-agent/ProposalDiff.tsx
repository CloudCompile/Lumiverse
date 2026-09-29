import type { ProposalFieldDiff } from '@/api/card-agent'
import { formatValue } from './format'
import styles from './CardAgentPanel.module.css'

/**
 * Before/after view for the fields a proposal would change.
 *
 * Long card fields run to thousands of characters, so each side is capped by
 * CSS with its own scroll rather than expanding the row.
 */
export default function ProposalDiff({ fields }: { fields: ProposalFieldDiff[] }) {
  return (
    <div className={styles.diffTable}>
      {fields
        .filter((field) => field.changed)
        .map((field) => (
          <div key={field.field} className={styles.diffRow}>
            <div className={styles.diffFieldName}>{field.field}</div>
            <div className={styles.diffSides}>
              <div className={styles.diffSide}>
                <span className={styles.diffLabel}>Before</span>
                <pre className={styles.diffText}>{formatValue(field.from)}</pre>
              </div>
              <div className={styles.diffSide}>
                <span className={styles.diffLabel}>After</span>
                <pre className={styles.diffText}>{formatValue(field.to)}</pre>
              </div>
            </div>
          </div>
        ))}
    </div>
  )
}
