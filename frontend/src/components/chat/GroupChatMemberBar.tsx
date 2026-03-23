import { useCallback } from 'react'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import styles from './GroupChatMemberBar.module.css'
import clsx from 'clsx'

interface GroupChatMemberBarProps {
  chatId: string
}

export default function GroupChatMemberBar({ chatId }: GroupChatMemberBarProps) {
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const mutedCharacterIds = useStore((s) => s.mutedCharacterIds)
  const characters = useStore((s) => s.characters)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const startStreaming = useStore((s) => s.startStreaming)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const toggleMuteCharacter = useStore((s) => s.toggleMuteCharacter)

  const handleForceGenerate = useCallback(
    async (characterId: string) => {
      if (isStreaming || mutedCharacterIds.includes(characterId)) return
      try {
        const res = await generateApi.start({
          chat_id: chatId,
          target_character_id: characterId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: getActivePresetForGeneration() || undefined,
          generation_type: 'normal',
        })
        startStreaming(res.generationId)
      } catch (err: any) {
        console.error('[GroupMemberBar] Force generate failed:', err)
        const msg = err?.body?.error || err?.message || 'Failed to generate'
        setStreamingError(msg)
      }
    },
    [chatId, isStreaming, mutedCharacterIds, activeProfileId, activePersonaId, getActivePresetForGeneration, startStreaming, setStreamingError]
  )

  const handleToggleMute = useCallback(
    async (e: React.MouseEvent, characterId: string) => {
      e.preventDefault()
      e.stopPropagation()
      const newMuted = toggleMuteCharacter(characterId)
      const isMuted = newMuted.includes(characterId)
      try {
        if (isMuted) {
          await chatsApi.muteCharacter(chatId, characterId)
        } else {
          await chatsApi.unmuteCharacter(chatId, characterId)
        }
      } catch (err) {
        console.error('[GroupMemberBar] Mute toggle failed:', err)
        // Revert on failure
        toggleMuteCharacter(characterId)
      }
    },
    [chatId, toggleMuteCharacter]
  )

  if (groupCharacterIds.length === 0) return null

  return (
    <div className={styles.bar}>
      {groupCharacterIds.map((id) => {
        const char = characters.find((c) => c.id === id)
        const isActive = id === activeGroupCharacterId
        const isMuted = mutedCharacterIds.includes(id)
        const talk = char?.talkativeness ?? 0.5
        return (
          <button
            key={id}
            type="button"
            className={clsx(
              styles.member,
              isActive && styles.memberActive,
              isMuted && styles.memberMuted,
              talk >= 0.7 && styles.talkHigh,
              talk <= 0.3 && styles.talkLow
            )}
            onClick={() => handleForceGenerate(id)}
            onContextMenu={(e) => handleToggleMute(e, id)}
            title={
              isMuted
                ? `${char?.name || 'Character'} — Muted (right-click to unmute)`
                : `${char?.name || 'Character'} — Click to generate, right-click to mute`
            }
            disabled={isStreaming}
          >
            {char?.avatar_path || char?.image_id ? (
              <img
                src={charactersApi.avatarUrl(id)}
                alt={char?.name}
                className={styles.avatar}
                loading="lazy"
              />
            ) : (
              <span className={styles.avatarFallback}>
                {char?.name?.[0]?.toUpperCase() || '?'}
              </span>
            )}
            <span className={styles.name}>{char?.name || 'Unknown'}</span>
            {isMuted && <span className={styles.mutedBadge} />}
          </button>
        )
      })}
    </div>
  )
}
