import type { StateCreator } from 'zustand'
import type { MigrationSlice } from '@/types/store'
import type { MigrationProgressPayload, MigrationLogPayload, MigrationCompletedPayload, MigrationFailedPayload } from '@/types/ws-events'

export const createMigrationSlice: StateCreator<MigrationSlice> = (set) => ({
  migrationId: null,
  migrationPhase: null,
  migrationProgress: null,
  migrationLogs: [],
  migrationResult: null,
  migrationError: null,

  setMigrationStarted: (id: string) => {
    set({
      migrationId: id,
      migrationPhase: 'starting',
      migrationProgress: null,
      migrationLogs: [],
      migrationResult: null,
      migrationError: null,
    })
  },

  setMigrationProgress: (payload: MigrationProgressPayload) => {
    set({
      migrationPhase: payload.phase,
      migrationProgress: { current: payload.current, total: payload.total, label: payload.label },
    })
  },

  addMigrationLog: (payload: MigrationLogPayload) => {
    set((state) => ({
      migrationLogs: [...state.migrationLogs, { level: payload.level, message: payload.message, timestamp: Date.now() }],
    }))
  },

  setMigrationCompleted: (payload: MigrationCompletedPayload) => {
    set({
      migrationPhase: 'completed',
      migrationProgress: null,
      migrationResult: payload,
    })
  },

  setMigrationFailed: (payload: MigrationFailedPayload) => {
    set({
      migrationPhase: 'failed',
      migrationProgress: null,
      migrationError: payload.error,
    })
  },

  resetMigration: () => {
    set({
      migrationId: null,
      migrationPhase: null,
      migrationProgress: null,
      migrationLogs: [],
      migrationResult: null,
      migrationError: null,
    })
  },
})
