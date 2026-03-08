import { useEffect, useRef } from 'react'
import { wsClient } from './client'
import { EventType } from './events'
import { useStore } from '@/store'
import { routeBackendMessage } from '@/lib/spindle/loader'
import { messagesApi } from '@/api/chats'
import { imageGenApi } from '@/api/image-gen'
import { toast } from '@/lib/toast'
import type {
  StreamTokenPayload,
  GenerationStartedPayload,
  GenerationEndedPayload,
  MessageSentPayload,
  MessageEditedPayload,
  MessageDeletedPayload,
  MessageSwipedPayload,
  GroupTurnStartedPayload,
  GroupRoundCompletePayload,
} from '@/types/ws-events'
import type { CouncilToolResult } from 'lumiverse-spindle-types'
import type { ActivatedWorldInfoEntry } from '@/types/api'

export function useWebSocket() {
  const store = useStore
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const session = useStore((s) => s.session)
  const lastExtensionSyncAtRef = useRef(0)

  useEffect(() => {
    if (!isAuthenticated) return

    const syncExtensions = (force = false) => {
      const now = Date.now()
      if (!force && now - lastExtensionSyncAtRef.current < 1000) return
      lastExtensionSyncAtRef.current = now
      store.getState().loadExtensions()
    }

    wsClient.connect(session?.token)

    const unsubs = [
      wsClient.on(EventType.MESSAGE_SENT, (payload: MessageSentPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.addMessage(payload.message)
        }
      }),

      wsClient.on(EventType.MESSAGE_EDITED, (payload: MessageEditedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.updateMessage(payload.message.id, payload.message)
        }
      }),

      wsClient.on(EventType.MESSAGE_DELETED, (payload: MessageDeletedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.removeMessage(payload.messageId)
        }
      }),

      wsClient.on(EventType.MESSAGE_SWIPED, (payload: MessageSwipedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.updateMessage(payload.message.id, payload.message)
        }
      }),

      wsClient.on(EventType.GENERATION_STARTED, (payload: GenerationStartedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId && state.activeGenerationId !== payload.generationId) {
          if (state.isGroupChat && payload.characterId) {
            state.setActiveGroupCharacter(payload.characterId)
          }
          state.startStreaming(payload.generationId, payload.targetMessageId)
        }
      }),

      wsClient.on(EventType.STREAM_TOKEN_RECEIVED, (payload: StreamTokenPayload) => {
        const state = store.getState()
        if (payload.generationId === state.activeGenerationId) {
          if (payload.type === 'reasoning') {
            state.appendStreamReasoning(payload.token)
          } else {
            state.appendStreamToken(payload.token)
          }
        }
      }),

      wsClient.on(EventType.GENERATION_ENDED, (payload: GenerationEndedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          if (payload.error) {
            state.setStreamingError(payload.error)
            toast.error(payload.error, { title: 'Generation Failed' })
          } else {
            // Cache breakdown data from WS event if present
            if (payload.messageId && (payload as any).breakdown) {
              const bd = (payload as any).breakdown
              state.cacheBreakdown(payload.messageId, {
                entries: bd.entries || [],
                totalTokens: bd.totalTokens || 0,
                maxContext: bd.maxContext || 0,
                model: bd.model || '',
                provider: bd.provider || '',
                presetName: bd.presetName,
                tokenizer_name: bd.tokenizer_name || null,
                chatId: payload.chatId,
              })
            }

            // In group chats, mark the character as spoken and keep the loop alive
            if (state.isGroupChat && state.activeGroupCharacterId) {
              state.markCharacterSpoken(state.activeGroupCharacterId)
            }

            // End streaming immediately, then reconcile the full message list
            // from backend source-of-truth to avoid id/index race conditions.
            state.endStreaming()
            messagesApi.list(payload.chatId, { limit: 200 }).then((res) => {
              const s = store.getState()
              if (s.activeChatId === payload.chatId) {
                s.setMessages(res.data, res.total)
              }
            }).catch(() => { /* ignore */ })

            const latest = store.getState()
            // Only trigger image gen when not in the middle of a group nudge loop
            if (
              !latest.isNudgeLoopActive &&
              latest.imageGeneration.enabled &&
              latest.imageGeneration.autoGenerate !== false &&
              !latest.sceneGenerating
            ) {
              latest.setSceneGenerating(true)
              imageGenApi.generate({
                chatId: payload.chatId,
                forceGeneration: !!latest.imageGeneration.forceGeneration,
              }).then((res) => {
                if (res.generated && res.imageDataUrl) {
                  store.getState().setSceneBackground(res.imageDataUrl)
                }
              }).catch((err) => {
                console.warn('[ImageGen] Auto-generate failed:', err)
              }).finally(() => {
                store.getState().setSceneGenerating(false)
              })
            }
          }
        }
      }),

      wsClient.on(EventType.GENERATION_STOPPED, () => {
        store.getState().stopStreaming()
      }),

      wsClient.on(EventType.GENERATION_ERROR, () => {
        store.getState().stopStreaming()
      }),

      // Group chat events
      wsClient.on(EventType.GROUP_TURN_STARTED, (payload: GroupTurnStartedPayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId && state.isGroupChat) {
          state.setActiveGroupCharacter(payload.characterId)
          state.setNudgeLoopActive(true)
          state.startStreaming(payload.generationId)
          if (payload.totalExpected > 0) {
            // Update round total if the backend tells us
            if (state.roundTotal !== payload.totalExpected) {
              state.startNewRound(payload.totalExpected)
            }
          }
        }
      }),

      wsClient.on(EventType.GROUP_ROUND_COMPLETE, (payload: GroupRoundCompletePayload) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId && state.isGroupChat) {
          state.setNudgeLoopActive(false)
          state.setActiveGroupCharacter(null)
          // Mark all spoken characters
          for (const id of payload.charactersSpoken) {
            state.markCharacterSpoken(id)
          }
        }
      }),

      wsClient.on(EventType.CONNECTED, () => {
        syncExtensions(true)
      }),

      // World Info activation
      wsClient.on(EventType.WORLD_INFO_ACTIVATED, (payload: { chatId: string; entries: ActivatedWorldInfoEntry[] }) => {
        const state = store.getState()
        if (payload.chatId === state.activeChatId) {
          state.setActivatedWorldInfo(payload.entries)
        }
      }),

      // Council events
      wsClient.on(EventType.COUNCIL_STARTED, () => {
        const state = store.getState()
        state.setCouncilExecuting(true)
        state.setCouncilToolResults([])
        state.setCouncilExecutionResult(null)
      }),

      wsClient.on(EventType.COUNCIL_MEMBER_DONE, (payload: { results: CouncilToolResult[] }) => {
        const state = store.getState()
        state.setCouncilToolResults([...state.councilToolResults, ...payload.results])
      }),

      wsClient.on(EventType.COUNCIL_COMPLETED, (payload: { totalDurationMs: number; resultCount: number }) => {
        const state = store.getState()
        state.setCouncilExecuting(false)
        state.setCouncilExecutionResult({
          results: state.councilToolResults,
          deliberationBlock: '',
          totalDurationMs: payload.totalDurationMs,
        })
      }),

      // Spindle extension events
      wsClient.on(EventType.SPINDLE_EXTENSION_LOADED, () => {
        syncExtensions()
        // Extension may have registered new tools — refresh council tool list
        useStore.getState().loadAvailableTools()
      }),

      wsClient.on(EventType.SPINDLE_EXTENSION_UNLOADED, () => {
        syncExtensions()
        // Extension tools may have been removed — refresh council tool list
        useStore.getState().loadAvailableTools()
      }),

      wsClient.on(EventType.SPINDLE_EXTENSION_ERROR, (payload: { extensionId: string; error: string }) => {
        console.error(`[Spindle] Extension error (${payload.extensionId}):`, payload.error)
        toast.error(payload.error, { title: 'Extension Error' })
        syncExtensions()
      }),

      wsClient.on(EventType.SPINDLE_FRONTEND_MSG, (payload: { extensionId: string; data: unknown }) => {
        routeBackendMessage(payload.extensionId, payload.data)
      }),

      // Legacy/event-bus bridge for message tag intercept notifications.
      // Some extensions emit MESSAGE_TAG_INTERCEPTED over WS and expect it
      // on the backend-message channel (ctx.onBackendMessage).
      wsClient.on(EventType.MESSAGE_TAG_INTERCEPTED, (payload: { extensionId?: string } & Record<string, unknown>) => {
        if (typeof payload?.extensionId === 'string' && payload.extensionId) {
          routeBackendMessage(payload.extensionId, payload)
        }
      }),
    ]

    return () => {
      unsubs.forEach(unsub => unsub())
      wsClient.disconnect()
    }
  }, [isAuthenticated, session?.token])
}
