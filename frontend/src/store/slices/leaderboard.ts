import type { StateCreator } from 'zustand'
import type { AppStore, LeaderboardSlice } from '@/types/store'
import { leaderboardApi } from '@/api/leaderboard'

export const createLeaderboardSlice: StateCreator<AppStore, [], [], LeaderboardSlice> = (set, get) => ({
  leaderboardEntries: [],
  leaderboardVotes: {},
  leaderboardLoading: false,

  loadLeaderboard: async () => {
    set({ leaderboardLoading: true })
    try {
      const entries = await leaderboardApi.getRankings()
      set({ leaderboardEntries: entries, leaderboardLoading: false })
    } catch {
      set({ leaderboardLoading: false })
    }
  },

  loadVotesForChat: async (chatId: string) => {
    try {
      const votes = await leaderboardApi.getVotesForChat(chatId)
      const map: Record<string, number> = {}
      for (const v of votes) {
        map[`${v.message_id}:${v.swipe_id}`] = v.vote
      }
      set({ leaderboardVotes: map })
    } catch {
      // silent
    }
  },

  castLeaderboardVote: async (input) => {
    try {
      const entry = await leaderboardApi.castVote(input)
      const key = `${input.messageId}:${input.swipeId}`
      set((s) => {
        const votes = { ...s.leaderboardVotes, [key]: input.vote }
        const entries = s.leaderboardEntries.map((e) =>
          e.model === entry.model && e.provider === entry.provider ? entry : e,
        )
        const exists = entries.some(
          (e) => e.model === entry.model && e.provider === entry.provider,
        )
        return {
          leaderboardVotes: votes,
          leaderboardEntries: exists ? entries : [...entries, entry],
        }
      })
    } catch {
      // silent
    }
  },

  removeLeaderboardVote: async (messageId, swipeId) => {
    const key = `${messageId}:${swipeId}`
    try {
      await leaderboardApi.removeVote(messageId, swipeId)
      set((s) => {
        const votes = { ...s.leaderboardVotes }
        delete votes[key]
        return { leaderboardVotes: votes }
      })
    } catch {
      // silent
    }
  },

  resetLeaderboard: async () => {
    try {
      await leaderboardApi.reset()
      set({ leaderboardEntries: [], leaderboardVotes: {} })
    } catch {
      // silent
    }
  },
})
