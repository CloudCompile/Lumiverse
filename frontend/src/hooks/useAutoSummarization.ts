import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import {
  generateSummary,
  getLastSummarizedInfo,
  shouldAutoSummarize,
} from '@/lib/summary/service'

/**
 * Always-mounted auto-summarization trigger. Lives at the App root so it runs
 * regardless of whether the Summary drawer tab is currently visible. Previously
 * this logic was embedded in `useSummary()`, which only mounts alongside the
 * SummaryEditor component — leaving users with auto-mode enabled but their
 * Summary tab closed unexpectedly stranded without automatic summaries.
 *
 * Work is dispatched via queueMicrotask so the React commit phase isn't tied
 * up by the initial metadata fetch. All further network work is awaited inside
 * the microtask — fire-and-forget from the effect's point of view.
 */
export function useAutoSummarization() {
  const activeChatId = useStore((s) => s.activeChatId)
  const messageCount = useStore((s) => s.messages.length)
  const mode = useStore((s) => s.summarization.mode)
  const autoInterval = useStore((s) => s.summarization.autoInterval)
  const isSummarizing = useStore((s) => s.isSummarizing)
  const isStreaming = useStore((s) => s.isStreaming)

  const inFlightRef = useRef(false)
  const lastTriggerCountRef = useRef<{ chatId: string; count: number } | null>(null)

  useEffect(() => {
    if (mode !== 'auto') return
    if (!activeChatId) return
    if (isSummarizing || isStreaming) return
    if (inFlightRef.current) return
    if (messageCount === 0) return

    // Guard against the effect re-running at the same message count for the same chat
    // (e.g. a streaming flag flip or an unrelated settings change).
    const lastTrigger = lastTriggerCountRef.current
    if (lastTrigger && lastTrigger.chatId === activeChatId && lastTrigger.count === messageCount) return

    const kickoff = async () => {
      inFlightRef.current = true
      try {
        const snapshot = useStore.getState()
        const chatId = snapshot.activeChatId
        if (!chatId) return

        const current = snapshot.summarization
        if (current.mode !== 'auto') return
        if (snapshot.isSummarizing || snapshot.isStreaming) return

        const info = await getLastSummarizedInfo(chatId)
        const lastCount = info?.messageCount ?? 0

        const live = useStore.getState()
        if (live.activeChatId !== chatId) return
        if (live.isSummarizing || live.isStreaming) return

        const currentMessageCount = live.messages.length
        if (!shouldAutoSummarize(currentMessageCount, lastCount, current.autoInterval)) return

        // Record the trigger so the effect won't re-enter for the same (chat, count).
        lastTriggerCountRef.current = { chatId, count: currentMessageCount }

        let connectionId: string | undefined
        if (current.apiSource === 'sidecar') {
          connectionId = undefined
        } else if (current.apiSource === 'dedicated' && current.dedicatedConnectionId) {
          connectionId = current.dedicatedConnectionId
        } else {
          connectionId = live.activeProfileId || undefined
        }

        const character = live.characters.find((c) => c.id === live.activeCharacterId)
        const characterName = character?.name || 'Character'
        const activePersona = live.personas.find((p) => p.id === live.activePersonaId)
        const userName = activePersona?.name || 'User'

        live.setIsSummarizing(true)
        try {
          await generateSummary({
            chatId,
            connectionId,
            messageContext: current.autoMessageContext,
            userName,
            characterName,
            systemPromptOverride: current.systemPromptOverride,
            userPromptOverride: current.userPromptOverride,
          })
        } catch (err) {
          console.error('[useAutoSummarization] Summary generation failed:', err)
        } finally {
          useStore.getState().setIsSummarizing(false)
        }
      } finally {
        inFlightRef.current = false
      }
    }

    queueMicrotask(kickoff)
  }, [activeChatId, messageCount, mode, autoInterval, isSummarizing, isStreaming])
}
