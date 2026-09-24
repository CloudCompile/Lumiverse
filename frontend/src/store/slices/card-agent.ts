import type { StateCreator } from 'zustand'
import type { AppStore, CardAgentSlice } from '@/types/store'
import { cardAgentApi } from '@/api/card-agent'
import type { CardAgentMessage } from '@/api/card-agent'
import { toast } from '@/lib/toast'

export const createCardAgentSlice: StateCreator<AppStore, [], [], CardAgentSlice> = (set, get) => ({
  cardAgentSessions: [],
  cardAgentActiveSessionId: null,
  cardAgentMessages: [],
  cardAgentProposals: [],
  cardAgentRevisions: {},
  cardAgentBusy: false,
  cardAgentLoading: false,

  loadCardAgentSessions: async () => {
    set({ cardAgentLoading: true })
    try {
      const sessions = await cardAgentApi.listSessions()
      set({ cardAgentSessions: sessions, cardAgentLoading: false })
    } catch {
      set({ cardAgentLoading: false })
    }
  },

  createCardAgentSession: async (input) => {
    const session = await cardAgentApi.createSession(input)
    set((s) => ({ cardAgentSessions: [session, ...s.cardAgentSessions] }))
    return session
  },

  selectCardAgentSession: async (sessionId) => {
    set({ cardAgentActiveSessionId: sessionId, cardAgentMessages: [], cardAgentProposals: [] })
    if (!sessionId) return
    try {
      const [messages, proposals] = await Promise.all([
        cardAgentApi.listMessages(sessionId),
        cardAgentApi.listProposals({ sessionId, status: 'pending' }),
      ])
      set({ cardAgentMessages: messages, cardAgentProposals: proposals })
    } catch {
      // A failed load leaves the pane empty rather than blocking the session.
    }
  },

  deleteCardAgentSession: async (sessionId) => {
    try {
      await cardAgentApi.deleteSession(sessionId)
      set((s) => ({
        cardAgentSessions: s.cardAgentSessions.filter((x) => x.id !== sessionId),
        ...(s.cardAgentActiveSessionId === sessionId
          ? { cardAgentActiveSessionId: null, cardAgentMessages: [], cardAgentProposals: [] }
          : {}),
      }))
      // The server rejects this session's pending proposals on delete, so drop
      // any of them that are showing in the global queue.
      const stillPending = get().cardAgentProposals.filter((p) => p.session_id !== sessionId)
      set({ cardAgentProposals: stillPending })
    } catch {
      toast.error('Could not delete the session')
    }
  },

  sendCardAgentTurn: async (message) => {
    const sessionId = get().cardAgentActiveSessionId
    if (!sessionId) return

    const trimmed = message.trim()
    if (!trimmed) return

    // Render the user's turn immediately; the reply arrives with the response.
    const optimistic: CardAgentMessage = {
      id: -Date.now(),
      role: 'user',
      content: trimmed,
      tool_activity: [],
      created_at: Math.floor(Date.now() / 1000),
    }
    set((s) => ({ cardAgentMessages: [...s.cardAgentMessages, optimistic], cardAgentBusy: true }))

    try {
      const result = await cardAgentApi.runTurn(sessionId, trimmed)
      const assistant: CardAgentMessage = {
        id: -Date.now() - 1,
        role: 'assistant',
        content: result.reply,
        tool_activity: result.toolActivity,
        created_at: Math.floor(Date.now() / 1000),
      }
      set((s) => ({
        cardAgentMessages: [...s.cardAgentMessages, assistant],
        cardAgentBusy: false,
        // Re-read the queue for this session so newly filed proposals appear.
        cardAgentProposals: [
          ...s.cardAgentProposals.filter((p) => p.session_id !== sessionId),
          ...result.proposals,
        ],
      }))
      if (result.proposals.length > 0) {
        toast.info(
          `${result.proposals.length} proposal${result.proposals.length === 1 ? '' : 's'} waiting for review`,
        )
      }
    } catch (err) {
      set({ cardAgentBusy: false })
      toast.error(err instanceof Error ? err.message : 'The turn failed')
    }
  },

  loadCardAgentProposals: async (params) => {
    try {
      const proposals = await cardAgentApi.listProposals({ status: 'pending', ...params })
      set({ cardAgentProposals: proposals })
    } catch {
      // Best-effort: the queue simply stays as-is.
    }
  },

  applyCardAgentProposal: async (proposalId) => {
    try {
      const result = await cardAgentApi.applyProposal(proposalId)
      set((s) => ({
        cardAgentProposals: s.cardAgentProposals.filter((p) => p.id !== proposalId),
      }))
      // Fold the server's updated card into the library in place, so the
      // editor and grid show the change without a full refetch.
      get().updateCharacter(result.character.id, result.character)
      toast.success('Edit applied')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not apply the edit'
      // A stale proposal no longer applies; drop it from the pending list and
      // let the user re-run the agent against the current card.
      if (message.includes('changed since')) {
        set((s) => ({ cardAgentProposals: s.cardAgentProposals.filter((p) => p.id !== proposalId) }))
        toast.warning('The card changed, so this proposal was discarded. Ask the agent to redo it.')
        return
      }
      toast.error(message)
    }
  },

  rejectCardAgentProposal: async (proposalId) => {
    try {
      await cardAgentApi.rejectProposal(proposalId)
      set((s) => ({ cardAgentProposals: s.cardAgentProposals.filter((p) => p.id !== proposalId) }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reject the proposal')
    }
  },

  applyCardAgentProposalBatch: async (params = {}) => {
    try {
      const result = await cardAgentApi.applyProposalBatch(params)
      await get().loadCardAgentProposals({ sessionId: params.sessionId })
      if (result.failed.length > 0) {
        toast.warning(`Applied ${result.applied}; ${result.failed.length} could not be applied`)
      } else {
        toast.success(`Applied ${result.applied} edit${result.applied === 1 ? '' : 's'}`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not apply the edits')
    }
  },

  loadCardAgentRevisions: async (characterId) => {
    try {
      const revisions = await cardAgentApi.listRevisions(characterId)
      set((s) => ({
        cardAgentRevisions: { ...s.cardAgentRevisions, [characterId]: revisions },
      }))
    } catch {
      // History is supplementary; a failure must not break the editor.
    }
  },

  revertCardAgentRevision: async (characterId, revisionId) => {
    try {
      const result = await cardAgentApi.revert(characterId, revisionId)
      await get().loadCardAgentRevisions(characterId)
      get().updateCharacter(result.character.id, result.character)
      toast.success('Reverted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revert')
    }
  },
})
