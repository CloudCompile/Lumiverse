import { BASE_URL, get, post, put, del } from './client'
import type { Preset, PresetRegistryItem, CreatePresetInput, UpdatePresetInput, PaginatedResult } from '@/types/api'
import type { PromptBlock } from '@/lib/loom/types'

export interface StashedPromptBlock {
  id: string
  block: Omit<PromptBlock, 'id' | 'enabled' | 'group' | 'stashId'>
  sourcePreset?: { id: string; name: string }
  createdAt: number
  updatedAt: number
}

export const presetsApi = {
  list(params?: { limit?: number; offset?: number; provider?: string }) {
    return get<PaginatedResult<Preset>>('/presets', params)
  },

  listRegistry(params?: { limit?: number; offset?: number; provider?: string; engine?: string }) {
    return get<PaginatedResult<PresetRegistryItem>>('/presets/registry', params)
  },

  get(id: string) {
    return get<Preset>(`/presets/${id}`)
  },

  create(input: CreatePresetInput) {
    return post<Preset>('/presets', input)
  },

  update(id: string, input: UpdatePresetInput) {
    return put<Preset>(`/presets/${id}`, input)
  },

  delete(id: string) {
    return del<void>(`/presets/${id}`)
  },

  bulkDelete(ids: string[]) {
    return post<{ deleted: string[] }>('/presets/bulk-delete', { ids })
  },

  prepareBulkExport(ids: string[]) {
    return post<{ downloadId: string; archiveUrl: string; filename: string; count: number }>(
      '/presets/bulk-export/prepare',
      { ids },
    )
  },

  downloadPreparedExport(archiveUrl: string, filename: string) {
    const anchor = document.createElement('a')
    anchor.href = archiveUrl.startsWith('/') ? archiveUrl : `${BASE_URL}${archiveUrl}`
    anchor.download = filename
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  },

  listStash() {
    return get<StashedPromptBlock[]>('/presets/stash')
  },

  addToStash(block: PromptBlock, sourcePresetId?: string) {
    return post<StashedPromptBlock>('/presets/stash', { block, sourcePresetId })
  },

  removeFromStash(id: string) {
    return del<void>(`/presets/stash/${id}`)
  },
}
