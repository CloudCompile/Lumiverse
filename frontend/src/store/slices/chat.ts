import type { StateCreator } from 'zustand'
import type { ChatSlice } from '@/types/store'
import type { Message } from '@/types/api'

/**
 * Inline reasoning detection state machine.
 *
 * Phases:
 *   detecting  – buffering initial tokens to check if they match the reasoning prefix
 *   reasoning  – inside a think block, routing tokens to streamingReasoning
 *   content    – normal content (either prefix never matched, or suffix was found)
 */
type StreamPhase = 'detecting' | 'reasoning' | 'content'

export const createChatSlice: StateCreator<ChatSlice> = (set, get) => {
  // Closure-scoped streaming state (not in zustand — avoids re-renders)
  let streamPhase: StreamPhase = 'content'
  let streamBuffer = ''
  // Tracks recently ended generation IDs, so that a late `startStreaming()`
  // call (e.g. from an HTTP response arriving after the WS GENERATION_ENDED
  // event in sidecar-council mode) doesn't restart a zombie streaming state.
  // We track a small set rather than a single ID because during rapid
  // stop→regenerate cycles, multiple generations may end in quick succession.
  const endedGenerationIds = new Set<string>()

  // ── RAF-throttled streaming buffers ──────────────────────────────────
  // Tokens accumulate here at full WS throughput (no React re-renders).
  // A requestAnimationFrame loop flushes to Zustand at display refresh
  // rate (~60fps), so expensive downstream rendering (markdown, OOC
  // parsing, DOM walks) runs at most once per frame instead of per-token.
  let rawStreamContent = ''
  let rawStreamReasoning = ''
  let streamFlushRaf = 0

  function scheduleStreamFlush() {
    if (!streamFlushRaf) {
      streamFlushRaf = requestAnimationFrame(() => {
        streamFlushRaf = 0
        set({
          streamingContent: rawStreamContent,
          streamingReasoning: rawStreamReasoning,
        })
      }) as unknown as number
    }
  }

  function cancelStreamFlush() {
    if (streamFlushRaf) {
      cancelAnimationFrame(streamFlushRaf)
      streamFlushRaf = 0
    }
  }

  function resetStreamPhase() {
    streamPhase = 'detecting'
    streamBuffer = ''
  }

  function sortMessagesByPosition(messages: Message[]): Message[] {
    return [...messages].sort((a, b) => {
      if (a.index_in_chat !== b.index_in_chat) return a.index_in_chat - b.index_in_chat
      if (a.send_date !== b.send_date) return a.send_date - b.send_date
      if (a.created_at !== b.created_at) return a.created_at - b.created_at
      return a.id.localeCompare(b.id)
    })
  }

  return {
    activeChatId: null,
    activeCharacterId: null,
    messages: [],
    isStreaming: false,
    streamingContent: '',
    streamingReasoning: '',
    streamingError: null,
    activeGenerationId: null,
    regeneratingMessageId: null,
    totalChatLength: 0,

    setActiveChat: (chatId, characterId = null) => {
      resetStreamPhase()
      endedGenerationIds.clear()
      set({
        activeChatId: chatId,
        activeCharacterId: characterId,
        messages: [],
        isStreaming: false,
        streamingContent: '',
        streamingReasoning: '',
        streamingError: null,
        activeGenerationId: null,
        regeneratingMessageId: null,
      })
    },

    setMessages: (messages, total?) =>
      set({ messages: sortMessagesByPosition(messages), totalChatLength: total ?? messages.length }),

    prependMessages: (olderMessages) =>
      set((state) => {
        const existingIds = new Set(state.messages.map((m) => m.id))
        const unique = olderMessages.filter((m) => !existingIds.has(m.id))
        if (unique.length === 0) return state
        return { messages: sortMessagesByPosition([...unique, ...state.messages]) }
      }),

    addMessage: (message) =>
      set((state) => {
        const byId = state.messages.findIndex((m) => m.id === message.id)
        if (byId !== -1) {
          const messages = [...state.messages]
          messages[byId] = message
          return { messages: sortMessagesByPosition(messages) }
        }

        const messages = sortMessagesByPosition([...state.messages, message])
        return { messages, totalChatLength: messages.length }
      }),

    updateMessage: (id, updates) =>
      set((state) => {
        let idx = -1
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].id === id) {
            idx = i
            break
          }
        }
        if (idx === -1) return { messages: state.messages }
        const messages = [...state.messages]
        messages[idx] = { ...messages[idx], ...updates }
        return { messages }
      }),

    removeMessage: (id) =>
      set((state) => {
        let idx = -1
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].id === id) {
            idx = i
            break
          }
        }
        if (idx === -1) return { messages: state.messages }
        const messages = state.messages.filter((_m, i) => i !== idx)
        return { messages, totalChatLength: messages.length }
      }),

    beginStreaming: (regeneratingMessageId) => {
      resetStreamPhase()
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({
        isStreaming: true,
        streamingContent: '',
        streamingReasoning: '',
        streamingError: null,
        activeGenerationId: null,
        regeneratingMessageId: regeneratingMessageId ?? null,
      })
    },

    startStreaming: (generationId, regeneratingMessageId) => {
      // Guard: don't restart a generation that already completed (race condition
      // in sidecar-council mode where GENERATION_ENDED arrives before the HTTP
      // response that triggers this call from InputArea).
      if (endedGenerationIds.has(generationId)) return
      // Guard: don't reset content for a generation that's already streaming
      // (WS GENERATION_STARTED may arrive slightly before the HTTP response).
      if (generationId === get().activeGenerationId) return

      const current = get()
      // If we're already in an optimistic streaming state (beginStreaming was
      // called), just wire up the generation ID without resetting buffers —
      // tokens may have already started arriving via WS.
      if (current.isStreaming && !current.activeGenerationId) {
        set({
          activeGenerationId: generationId,
          regeneratingMessageId: regeneratingMessageId ?? current.regeneratingMessageId,
        })
        return
      }

      resetStreamPhase()
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({
        isStreaming: true,
        streamingContent: '',
        streamingReasoning: '',
        streamingError: null,
        activeGenerationId: generationId,
        regeneratingMessageId: regeneratingMessageId ?? null,
      })
    },

    appendStreamToken: (token) => {
      // Read reasoning settings from the full store (all slices are merged at runtime)
      const fullStore = get() as any
      const settings = fullStore.reasoningSettings
      const autoParse = settings?.autoParse

      // All token appends go to closure-scoped buffers (rawStreamContent /
      // rawStreamReasoning). A RAF loop flushes to Zustand at display refresh
      // rate so downstream React rendering runs at most once per frame.

      if (!autoParse) {
        rawStreamContent += token
        scheduleStreamFlush()
        return
      }

      const rawPrefix = ((settings?.prefix as string) || '<think>\n').replace(/^\n+|\n+$/g, '')
      const rawSuffix = ((settings?.suffix as string) || '\n</think>').replace(/^\n+|\n+$/g, '')

      if (streamPhase === 'detecting') {
        streamBuffer += token
        const trimmed = streamBuffer.trimStart()

        if (trimmed.length >= rawPrefix.length && trimmed.startsWith(rawPrefix)) {
          streamPhase = 'reasoning'
          const afterPrefix = trimmed.slice(rawPrefix.length)
          streamBuffer = ''

          if (afterPrefix) {
            const suffixIdx = afterPrefix.indexOf(rawSuffix)
            if (suffixIdx !== -1) {
              streamPhase = 'content'
              rawStreamReasoning += afterPrefix.slice(0, suffixIdx)
              rawStreamContent += afterPrefix.slice(suffixIdx + rawSuffix.length)
            } else {
              rawStreamReasoning += afterPrefix
            }
          }
        } else if (rawPrefix.startsWith(trimmed)) {
          // Partial match — keep buffering (no flush needed yet)
          return
        } else {
          streamPhase = 'content'
          rawStreamContent += streamBuffer
          streamBuffer = ''
        }
      } else if (streamPhase === 'reasoning') {
        rawStreamReasoning += token
        const suffixIdx = rawStreamReasoning.indexOf(rawSuffix)
        if (suffixIdx !== -1) {
          streamPhase = 'content'
          const afterSuffix = rawStreamReasoning.slice(suffixIdx + rawSuffix.length)
          rawStreamReasoning = rawStreamReasoning.slice(0, suffixIdx)
          rawStreamContent += afterSuffix
        }
      } else {
        rawStreamContent += token
      }

      scheduleStreamFlush()
    },

    appendStreamReasoning: (token) => {
      rawStreamReasoning += token
      scheduleStreamFlush()
    },

    endStreaming: () => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      // Cap the set size to prevent unbounded growth
      if (endedGenerationIds.size > 20) {
        const first = endedGenerationIds.values().next().value
        if (first) endedGenerationIds.delete(first)
      }
      streamPhase = 'content'
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({ isStreaming: false, streamingContent: '', streamingReasoning: '', streamingError: null, activeGenerationId: null, regeneratingMessageId: null })
    },

    stopStreaming: () => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      streamPhase = 'content'
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({ isStreaming: false, streamingContent: '', streamingReasoning: '', streamingError: null, activeGenerationId: null, regeneratingMessageId: null })
    },

    setStreamingError: (error) => {
      const id = get().activeGenerationId
      if (id) endedGenerationIds.add(id)
      streamPhase = 'content'
      cancelStreamFlush()
      rawStreamContent = ''
      rawStreamReasoning = ''
      set({ streamingError: error, isStreaming: false, activeGenerationId: null, regeneratingMessageId: null })
    },

    markGenerationEnded: (generationId) => {
      endedGenerationIds.add(generationId)
      if (endedGenerationIds.size > 20) {
        const first = endedGenerationIds.values().next().value
        if (first) endedGenerationIds.delete(first)
      }
    },
  }
}
