// API client for the Janitor Bridge feature.
//
// Mirrors the routes in src/routes/janitor-bridge.routes.ts. The card
// management endpoints use Lumiverse session auth (cookies); the OpenAI-
// compatible proxy endpoints use a separate bridge-key bearer token and
// are NOT called from this client (they're called by Janitor AI's UI).

import { get, post, put, del } from './client'

export interface JanitorBridgeConfig {
  enabled: boolean
  autoTag: boolean
  apiBase: string
  hasBridgeKey: boolean
  hasJanitorApiKey: boolean
  captureCount: number
  lastCaptureAt: number | null
}

export interface CapturedCard {
  id: string
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  tags: string[]
  creator: string
  image_id: string | null
  created_at: number
  updated_at: number
  // Janitor bridge extension fields:
  persona_hash: string | null
  source_url: string | null
  chat_count: number
  first_chat_at: number | null
  last_chat_at: number | null
  janitor_card_id: string | null
}

export interface CapturedCardsList {
  data: CapturedCard[]
  total: number
}

export interface BridgeStats {
  totalCaptured: number
  captureCount: number
  lastCaptureAt: number | null
  enabled: boolean
}

export interface GenerateKeyResponse {
  key: string
  message: string
}

export const janitorBridgeApi = {
  getConfig() {
    return get<JanitorBridgeConfig>('/janitor-bridge/config')
  },

  updateConfig(patch: Partial<Pick<JanitorBridgeConfig, 'enabled' | 'autoTag' | 'apiBase'>>) {
    return put<JanitorBridgeConfig>('/janitor-bridge/config', patch)
  },

  generateBridgeKey() {
    return post<GenerateKeyResponse>('/janitor-bridge/config/key')
  },

  setJanitorApiKey(apiKey: string) {
    return put<{ success: boolean }>('/janitor-bridge/config/janitor-key', { api_key: apiKey })
  },

  clearJanitorApiKey() {
    return del<{ success: boolean }>('/janitor-bridge/config/janitor-key')
  },

  listCards(opts: { limit?: number; offset?: number; search?: string; tag?: string } = {}) {
    const params = new URLSearchParams()
    if (opts.limit != null) params.set('limit', String(opts.limit))
    if (opts.offset != null) params.set('offset', String(opts.offset))
    if (opts.search) params.set('search', opts.search)
    if (opts.tag) params.set('tag', opts.tag)
    const qs = params.toString()
    return get<CapturedCardsList>(`/janitor-bridge/cards${qs ? `?${qs}` : ''}`)
  },

  getCard(id: string) {
    return get<CapturedCard>(`/janitor-bridge/cards/${id}`)
  },

  deleteCard(id: string) {
    return del<{ success: boolean }>(`/janitor-bridge/cards/${id}`)
  },

  getStats() {
    return get<BridgeStats>('/janitor-bridge/stats')
  },
}
