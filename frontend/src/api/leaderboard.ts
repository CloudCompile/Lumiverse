import { get, post, del } from './client'
import type { LeaderboardEntry, LeaderboardVote, CastVoteInput } from '@/types/api'

export const leaderboardApi = {
  getRankings() {
    return get<LeaderboardEntry[]>('/leaderboard')
  },

  getVotesForChat(chatId: string) {
    return get<LeaderboardVote[]>('/leaderboard/votes', { chatId })
  },

  getVote(messageId: string, swipeId: number) {
    return get<LeaderboardVote | { vote: 0 }>(`/leaderboard/votes/${messageId}/${swipeId}`)
  },

  castVote(input: CastVoteInput) {
    return post<LeaderboardEntry>('/leaderboard/vote', input)
  },

  removeVote(messageId: string, swipeId: number) {
    return del<{ success: boolean }>(`/leaderboard/vote/${messageId}/${swipeId}`)
  },

  reset() {
    return post<{ success: boolean }>('/leaderboard/reset')
  },
}
