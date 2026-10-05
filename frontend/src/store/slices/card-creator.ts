import type { StateCreator } from 'zustand'
import type { AppStore, CardCreatorSlice } from '@/types/store'
import { cardCreatorApi } from '@/api/card-creator'
import { toast } from '@/lib/toast'

/**
 * Card Creator: the review state for proposals filed inside a chat.
 *
 * Each chat that the creator has authored in owns its own proposal list; the
 * message that filed a proposal carries its ids in `extra`, so the chat bubble
 * renders only the proposals belonging to that turn while this slice keeps the
 * whole chat's queue for lookups and post-apply refreshes.
 */
export const createCardCreatorSlice: StateCreator<AppStore, [], [], CardCreatorSlice> = (set, get) => ({
  cardCreatorProposals: {},

  loadCardCreatorProposals: async (chatId) => {
    if (!chatId) return
    try {
      const proposals = await cardCreatorApi.listProposals(chatId)
      set((s) => ({ cardCreatorProposals: { ...s.cardCreatorProposals, [chatId]: proposals } }))
    } catch {
      // Best-effort: a failed load leaves the chat as-is rather than blocking it.
    }
  },

  applyCardCreatorProposal: async (chatId, proposalId) => {
    try {
      const result = await cardCreatorApi.applyProposal(proposalId)
      // Fold the updated card into the library in place so the editor and grid
      // reflect the change without a full refetch.
      get().updateCharacter(result.character.id, result.character)
      set((s) => ({
        cardCreatorProposals: {
          ...s.cardCreatorProposals,
          [chatId]: (s.cardCreatorProposals[chatId] ?? []).filter((p) => p.id !== proposalId),
        },
      }))
      toast.success('Edit applied')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not apply the edit'
      // A stale proposal no longer applies; drop it and let the user re-run the
      // creator against the current card.
      if (message.includes('changed since')) {
        set((s) => ({
          cardCreatorProposals: {
            ...s.cardCreatorProposals,
            [chatId]: (s.cardCreatorProposals[chatId] ?? []).filter((p) => p.id !== proposalId),
          },
        }))
        toast.warning('The card changed, so this proposal was discarded. Ask the creator to redo it.')
        return
      }
      toast.error(message)
    }
  },

  rejectCardCreatorProposal: async (chatId, proposalId) => {
    try {
      await cardCreatorApi.rejectProposal(proposalId)
      set((s) => ({
        cardCreatorProposals: {
          ...s.cardCreatorProposals,
          [chatId]: (s.cardCreatorProposals[chatId] ?? []).filter((p) => p.id !== proposalId),
        },
      }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reject the proposal')
    }
  },
})
