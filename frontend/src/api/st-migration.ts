import { get, post } from './client'

export interface BrowseResult {
  path: string
  parent: string | null
  entries: { name: string }[]
}

export interface ValidateResult {
  valid: boolean
  basePath?: string
  stUsers?: string[]
  layout?: 'multi-user' | 'legacy'
  error?: string
}

export interface ScanResult {
  characters: number
  chatDirs: number
  totalChatFiles: number
  groupChats: number
  groupChatFiles: number
  worldBooks: number
  personas: number
}

export interface MigrationScope {
  characters: boolean
  worldBooks: boolean
  personas: boolean
  chats: boolean
  groupChats: boolean
}

export interface ExecuteResult {
  migrationId: string
}

export interface MigrationStatus {
  status: 'idle' | 'running' | 'completed' | 'failed'
  migrationId?: string
  phase?: string
  startedAt?: number
  results?: Record<string, any>
  error?: string
}

export const stMigrationApi = {
  browse(path?: string) {
    return get<BrowseResult>('/st-migration/browse', path ? { path } : undefined)
  },

  validate(path: string) {
    return post<ValidateResult>('/st-migration/validate', { path })
  },

  scan(dataDir: string) {
    return post<ScanResult>('/st-migration/scan', { dataDir })
  },

  execute(params: { dataDir: string; targetUserId: string; scope: MigrationScope }) {
    return post<ExecuteResult>('/st-migration/execute', params)
  },

  status() {
    return get<MigrationStatus>('/st-migration/status')
  },
}
