import { useCallback, useMemo } from 'react'
import { useStore } from '@/store'
import { messagesApi } from '@/api/chats'
import { toast } from '@/lib/toast'

export function useMessageSelect(chatId: string) {
  const messageSelectMode = useStore((s) => s.messageSelectMode)
  const selectedMessageIds = useStore((s) => s.selectedMessageIds)
  const messages = useStore((s) => s.messages)
  const setMessageSelectMode = useStore((s) => s.setMessageSelectMode)
  const toggleMessageSelect = useStore((s) => s.toggleMessageSelect)
  const selectAllMessages = useStore((s) => s.selectAllMessages)
  const clearMessageSelection = useStore((s) => s.clearMessageSelection)
  const selectMessageRange = useStore((s) => s.selectMessageRange)
  const updateMessage = useStore((s) => s.updateMessage)

  const selectedCount = selectedMessageIds.length
  const totalCount = messages.length

  const hasHiddenSelected = useMemo(
    () => selectedMessageIds.some((id) => {
      const msg = messages.find((m) => m.id === id)
      return msg?.extra?.hidden === true
    }),
    [selectedMessageIds, messages]
  )

  const hasVisibleSelected = useMemo(
    () => selectedMessageIds.some((id) => {
      const msg = messages.find((m) => m.id === id)
      return !msg?.extra?.hidden
    }),
    [selectedMessageIds, messages]
  )

  const enterSelectMode = useCallback(() => {
    setMessageSelectMode(true)
  }, [setMessageSelectMode])

  const exitSelectMode = useCallback(() => {
    setMessageSelectMode(false)
  }, [setMessageSelectMode])

  const bulkHide = useCallback(async (hidden: boolean) => {
    if (selectedMessageIds.length === 0) return
    try {
      const result = await messagesApi.bulkHide(chatId, selectedMessageIds, hidden)
      for (const msg of result.messages) {
        updateMessage(msg.id, msg)
      }
      toast.success(`${result.updated} message${result.updated !== 1 ? 's' : ''} ${hidden ? 'hidden' : 'unhidden'}`)
      setMessageSelectMode(false)
    } catch (err) {
      console.error('[useMessageSelect] Bulk hide failed:', err)
      toast.error('Failed to update messages')
    }
  }, [chatId, selectedMessageIds, updateMessage, setMessageSelectMode])

  return {
    messageSelectMode,
    selectedMessageIds,
    selectedCount,
    totalCount,
    hasHiddenSelected,
    hasVisibleSelected,
    enterSelectMode,
    exitSelectMode,
    toggleMessageSelect,
    selectAllMessages,
    clearMessageSelection,
    selectMessageRange,
    bulkHide,
  }
}
