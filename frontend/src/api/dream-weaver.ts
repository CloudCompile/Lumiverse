import * as apiClient from './client'

export interface DreamWeaverAlternateField {
  id: string
  label: string
  content: string
}

export interface DreamWeaverGreeting {
  id: string
  label: string
  content: string
}

export interface DreamWeaverVoiceGuidance {
  compiled: string
  rules: {
    baseline: string[]
    rhythm: string[]
    diction: string[]
    quirks: string[]
    hard_nos: string[]
  }
}

export interface DreamWeaverDraft {
  format: 'DW_DRAFT_V1'
  version: 1
  kind: 'character' | 'scenario'
  meta: {
    title: string
    summary: string
    tags: string[]
    content_rating: 'sfw' | 'nsfw'
  }
  card: {
    name: string
    appearance: string
    description: string
    personality: string
    scenario: string
    first_mes: string
    system_prompt: string
    post_history_instructions: string
  }
  voice_guidance: DreamWeaverVoiceGuidance
  alternate_fields: {
    description: DreamWeaverAlternateField[]
    personality: DreamWeaverAlternateField[]
    scenario: DreamWeaverAlternateField[]
  }
  greetings: DreamWeaverGreeting[]
  lorebooks: any[]
  npc_definitions: any[]
  regex_scripts: any[]
}

export interface DreamWeaverSession {
  id: string
  user_id: string
  created_at: number
  updated_at: number
  dream_text: string
  tone: string | null
  constraints: string | null
  dislikes: string | null
  persona_id: string | null
  connection_id: string | null
  draft: string | null
  status: 'draft' | 'generating' | 'complete' | 'error'
  character_id: string | null
}

export interface CreateSessionInput {
  dream_text: string
  tone?: string
  constraints?: string
  dislikes?: string
  persona_id?: string
  connection_id?: string
}

export interface UpdateSessionInput {
  dream_text?: string
  tone?: string | null
  constraints?: string | null
  dislikes?: string | null
  persona_id?: string | null
  connection_id?: string | null
  draft?: DreamWeaverDraft | null
}

export const dreamWeaverApi = {
  createSession: (input: CreateSessionInput) =>
    apiClient.post<DreamWeaverSession>('/dream-weaver/sessions', input),

  getSessions: () =>
    apiClient.get<DreamWeaverSession[]>('/dream-weaver/sessions'),

  getSession: (id: string) =>
    apiClient.get<DreamWeaverSession>(`/dream-weaver/sessions/${id}`),

  updateSession: (id: string, input: UpdateSessionInput) =>
    apiClient.put<DreamWeaverSession>(`/dream-weaver/sessions/${id}`, input),

  generateDraft: (id: string) =>
    apiClient.post<DreamWeaverDraft>(`/dream-weaver/sessions/${id}/generate`, {}),

  finalize: (id: string) =>
    apiClient.post<{ characterId: string }>(`/dream-weaver/sessions/${id}/finalize`, {}),

  deleteSession: (id: string) =>
    apiClient.del(`/dream-weaver/sessions/${id}`),
}
