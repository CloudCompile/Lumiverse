import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Badge } from '@/components/shared/Badge'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import type { DryRunResponse } from '@/api/generate'
import styles from './DryRunModal.module.css'
import clsx from 'clsx'

const ROLE_COLOR: Record<string, 'warning' | 'info' | 'primary'> = {
  system: 'warning',
  user: 'info',
  assistant: 'primary',
}

export default function DryRunModal() {
  const modalProps = useStore((s) => s.modalProps) as DryRunResponse
  const closeModal = useStore((s) => s.closeModal)

  const [breakdownOpen, setBreakdownOpen] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(false)
  const [wiStatsOpen, setWiStatsOpen] = useState(false)
  const [memStatsOpen, setMemStatsOpen] = useState(false)

  const { messages, breakdown, parameters, assistantPrefill, model, provider, tokenCount, worldInfoStats, memoryStats } = modalProps

  // Build a token count lookup from tokenCount.breakdown (matched by name)
  const tokensByName = new Map<string, number>()
  if (tokenCount?.breakdown) {
    for (const entry of tokenCount.breakdown) {
      tokensByName.set(entry.name, entry.tokens)
    }
  }

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth="clamp(340px, 94vw, min(1100px, var(--lumiverse-content-max-width, 1100px)))" className={styles.modal}>
          {/* Header */}
          <div className={styles.header}>
            <h3 className={styles.headerTitle}>Prompt Dry Run</h3>
            <Badge color="primary">
              {provider} / {model}
            </Badge>
            <CloseButton onClick={closeModal} variant="solid" className={styles.closeBtn} />
          </div>

          {/* Scrollable body */}
          <div className={styles.body}>
            {/* Messages */}
            <div className={styles.messagesSection}>
              <p className={styles.sectionLabel}>
                Messages ({messages.length})
              </p>
              {messages.map((msg, i) => (
                <div key={i} className={styles.messageCard}>
                  <div className={styles.messageHeader}>
                    <Badge color={ROLE_COLOR[msg.role] ?? 'neutral'} size="sm" className={styles.roleBadge}>
                      {msg.role}
                    </Badge>
                    <span className={styles.messageIndex}>#{i + 1}</span>
                  </div>
                  <div className={styles.messageContent}>{msg.content}</div>
                </div>
              ))}
            </div>

            {/* Assistant prefill */}
            {assistantPrefill && (
              <div className={styles.prefillSection}>
                <p className={styles.prefillLabel}>Assistant Prefill</p>
                <div className={styles.prefillContent}>{assistantPrefill}</div>
              </div>
            )}

            {/* Breakdown */}
            {breakdown.length > 0 && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setBreakdownOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, breakdownOpen && styles.chevronOpen)}
                  />
                  Assembly Breakdown ({breakdown.length})
                </button>
                {breakdownOpen && (
                  <div className={styles.collapsibleBody}>
                    {tokenCount && (
                      <div className={styles.breakdownSummary}>
                        <span>{tokenCount.total_tokens.toLocaleString()} total tokens</span>
                        {tokenCount.tokenizer_name && (
                          <span className={styles.breakdownSource}>via {tokenCount.tokenizer_name}</span>
                        )}
                      </div>
                    )}
                    <div className={styles.breakdownList}>
                      {breakdown.map((entry, i) => {
                        const tokens = tokensByName.get(entry.name)
                        return (
                          <div key={i} className={styles.breakdownEntry}>
                            <span className={styles.breakdownLabel}>{entry.name}</span>
                            <span className={styles.breakdownSource}>{entry.type}</span>
                            {entry.role && (
                              <span className={styles.breakdownRole}>{entry.role}</span>
                            )}
                            {tokens != null && (
                              <span className={styles.breakdownTokens}>
                                {tokens.toLocaleString()} tokens
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* World Info Stats */}
            {worldInfoStats && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setWiStatsOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, wiStatsOpen && styles.chevronOpen)}
                  />
                  World Info ({worldInfoStats.totalActivated} activated
                  {worldInfoStats.evictedByBudget > 0 && `, ${worldInfoStats.evictedByBudget} evicted`})
                </button>
                {wiStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Total candidates</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.totalCandidates}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Keyword activated</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.keywordActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Vector activated</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.vectorActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Activated (final)</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.totalActivated}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Activated (before budget)</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.activatedBeforeBudget}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Activated (after budget)</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.activatedAfterBudget}</span>
                      </div>
                      {worldInfoStats.evictedByBudget > 0 && (
                        <div className={styles.breakdownEntry}>
                          <span className={styles.breakdownLabel}>Evicted by budget</span>
                          <span className={styles.breakdownTokens} style={{ color: '#ffab00' }}>
                            {worldInfoStats.evictedByBudget}
                          </span>
                        </div>
                      )}
                      {worldInfoStats.evictedByMinPriority > 0 && (
                        <div className={styles.breakdownEntry}>
                          <span className={styles.breakdownLabel}>Below min priority</span>
                          <span className={styles.breakdownTokens} style={{ color: '#ffab00' }}>
                            {worldInfoStats.evictedByMinPriority}
                          </span>
                        </div>
                      )}
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Estimated tokens</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.estimatedTokens.toLocaleString()}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Recursion passes used</span>
                        <span className={styles.breakdownTokens}>{worldInfoStats.recursionPassesUsed}</span>
                      </div>
                      {worldInfoStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>Vector query preview</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {worldInfoStats.queryPreview}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Memory Stats */}
            {memoryStats && memoryStats.enabled && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setMemStatsOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, memStatsOpen && styles.chevronOpen)}
                  />
                  Long-Term Memory ({memoryStats.chunksRetrieved} retrieved
                  {memoryStats.chunksPending > 0 && `, ${memoryStats.chunksPending} pending`})
                </button>
                {memStatsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.breakdownList}>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Injection method</span>
                        <span className={styles.breakdownTokens}>{memoryStats.injectionMethod}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Chunks available</span>
                        <span className={styles.breakdownTokens}>{memoryStats.chunksAvailable}</span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Chunks pending vectorization</span>
                        <span className={styles.breakdownTokens} style={memoryStats.chunksPending > 0 ? { color: '#ffab00' } : undefined}>
                          {memoryStats.chunksPending}
                        </span>
                      </div>
                      <div className={styles.breakdownEntry}>
                        <span className={styles.breakdownLabel}>Settings source</span>
                        <span className={styles.breakdownTokens}>{memoryStats.settingsSource}</span>
                      </div>
                      {memoryStats.queryPreview && (
                        <div className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                          <span className={styles.breakdownLabel}>Query preview</span>
                          <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto', fontSize: 11 }}>
                            {memoryStats.queryPreview}
                          </span>
                        </div>
                      )}
                      {memoryStats.retrievedChunks.length > 0 && (
                        <>
                          <div className={styles.breakdownEntry} style={{ marginTop: 8 }}>
                            <span className={styles.breakdownLabel} style={{ fontWeight: 600 }}>Retrieved Chunks</span>
                          </div>
                          {memoryStats.retrievedChunks.map((chunk, i) => (
                            <div key={i} className={styles.breakdownEntry} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, paddingLeft: 8 }}>
                              <span className={styles.breakdownLabel}>
                                #{i + 1} — score: {chunk.score.toFixed(4)}, ~{chunk.tokenEstimate} tokens
                              </span>
                              <span className={styles.breakdownSource} style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontSize: 11, display: 'block' }}>
                                {chunk.preview}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Parameters */}
            {Object.keys(parameters).length > 0 && (
              <div className={styles.collapsible}>
                <button
                  type="button"
                  className={styles.collapsibleHeader}
                  onClick={() => setParamsOpen((o) => !o)}
                >
                  <ChevronRight
                    size={14}
                    className={clsx(styles.chevron, paramsOpen && styles.chevronOpen)}
                  />
                  Parameters
                </button>
                {paramsOpen && (
                  <div className={styles.collapsibleBody}>
                    <div className={styles.parametersJson}>
                      {JSON.stringify(parameters, null, 2)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
    </ModalShell>
  )
}
