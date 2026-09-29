import { get, post } from './client'
import type { Character } from '@/types/api'
import type { EditProposal, ProposalStatus, CharacterRevision } from './card-agent'

/**
 * Card Creator client.
 *
 * The creator itself is an ordinary character; only the pieces chat does not
 * cover live behind this module — resolving the creator, and the proposals
 * filed inside a chat.
 */

/** A proposal as returned by the creator endpoints: always diff-annotated. */
export type CardCreatorProposal = EditProposal & { diff?: NonNullable<EditProposal['diff']> }

export const cardCreatorApi = {
  getCreator() {
    return get<{ character: Character }>('/card-creator/creator')
  },

  listProposals(chatId: string, status?: ProposalStatus) {
    return get<CardCreatorProposal[]>('/card-creator/proposals', { chatId, status })
  },

  getProposal(id: number) {
    return get<CardCreatorProposal>(`/card-creator/proposals/${id}`)
  },

  applyProposal(id: number) {
    return post<{ character: Character; revision: CharacterRevision; proposal: EditProposal }>(
      `/card-creator/proposals/${id}/apply`,
    )
  },

  rejectProposal(id: number) {
    return post<EditProposal>(`/card-creator/proposals/${id}/reject`)
  },
}
