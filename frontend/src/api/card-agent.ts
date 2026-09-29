import { get, post, patch, del } from './client'
import type { Character } from '@/types/api'

/**
 * Card Agent client: sessions, the proposal review queue, and revisions.
 */

// A turn runs a full model→tools→model loop, so it must not inherit the default
// request timeout.
const LLM_CALL = { timeout: 0 } as const

export type CardAgentScopeMode = 'all' | 'selection'

export interface CardAgentSession {
  id: string
  title: string
  connection_id: string | null
  model: string | null
  scope_mode: CardAgentScopeMode
  scope_character_ids: string[]
  created_at: number
  updated_at: number
}

export interface ToolActivity {
  name: string
  args: Record<string, unknown>
  ok: boolean
  summary: string
}

export interface CardAgentMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  tool_activity: ToolActivity[]
  created_at: number
}

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale'

export interface FieldChange {
  from: unknown
  to: unknown
}

export interface ProposalFieldDiff {
  field: string
  from: unknown
  to: unknown
  changed: boolean
}

export interface ProposalDiff {
  characterId: string
  characterName: string
  stale: boolean
  fields: ProposalFieldDiff[]
}

export interface EditProposal {
  id: number
  character_id: string
  character_name: string
  session_id: string | null
  changes: Record<string, FieldChange>
  rationale: string | null
  status: ProposalStatus
  base_content_hash: string
  base_updated_at: number | null
  applied_revision_id: number | null
  created_at: number
  resolved_at: number | null
  diff?: ProposalDiff
}

export interface CharacterRevision {
  id: number
  character_id: string
  revision_number: number
  origin: 'agent' | 'user' | 'import' | 'revert' | 'system'
  session_id: string | null
  label: string | null
  created_at: number
}

export interface CharacterRevisionWithSnapshot extends CharacterRevision {
  snapshot: Record<string, unknown>
}

export interface RunTurnResult {
  reply: string
  toolActivity: ToolActivity[]
  proposals: EditProposal[]
  rounds: number
}

export const cardAgentApi = {
  listSessions() {
    return get<CardAgentSession[]>('/card-agent/sessions')
  },

  createSession(input: {
    title?: string
    connectionId?: string | null
    model?: string | null
    scopeMode?: CardAgentScopeMode
    scopeCharacterIds?: string[]
  }) {
    return post<CardAgentSession>('/card-agent/sessions', input)
  },

  getSession(id: string) {
    return get<CardAgentSession>(`/card-agent/sessions/${id}`)
  },

  updateSession(id: string, patchBody: Partial<Pick<CardAgentSession, 'title' | 'connection_id' | 'model' | 'scope_mode' | 'scope_character_ids'>>) {
    return patch<CardAgentSession>(`/card-agent/sessions/${id}`, patchBody)
  },

  deleteSession(id: string) {
    return del<{ ok: boolean }>(`/card-agent/sessions/${id}`)
  },

  listMessages(id: string) {
    return get<CardAgentMessage[]>(`/card-agent/sessions/${id}/messages`)
  },

  runTurn(id: string, message: string) {
    return post<RunTurnResult>(`/card-agent/sessions/${id}/turns`, { message }, LLM_CALL)
  },

  listProposals(params: { status?: ProposalStatus; characterId?: string; sessionId?: string } = {}) {
    return get<EditProposal[]>('/card-agent/proposals', params)
  },

  getProposal(id: number) {
    return get<EditProposal>(`/card-agent/proposals/${id}`)
  },

  applyProposal(id: number) {
    return post<{ character: Character; revision: CharacterRevision; proposal: EditProposal }>(
      `/card-agent/proposals/${id}/apply`,
    )
  },

  rejectProposal(id: number) {
    return post<EditProposal>(`/card-agent/proposals/${id}/reject`)
  },

  applyProposalBatch(input: { sessionId?: string; characterIds?: string[] } = {}) {
    return post<{ applied: number; failed: Array<{ proposalId: number; characterId: string; error: string }> }>(
      '/card-agent/proposals/apply-batch',
      input,
    )
  },

  listRevisions(characterId: string, limit = 50) {
    return get<CharacterRevision[]>(`/card-agent/characters/${characterId}/revisions`, { limit })
  },

  getRevision(characterId: string, revisionId: number) {
    return get<CharacterRevisionWithSnapshot>(
      `/card-agent/characters/${characterId}/revisions/${revisionId}`,
    )
  },

  revert(characterId: string, revisionId: number) {
    return post<{ character: Character; revision: CharacterRevision }>(
      `/card-agent/characters/${characterId}/revisions/${revisionId}/revert`,
    )
  },
}