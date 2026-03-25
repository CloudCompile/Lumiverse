import { useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { Plus, Zap, VolumeX, Volume2, UserMinus } from 'lucide-react'
import styles from './GroupChatMemberBar.module.css'
import clsx from 'clsx'

interface GroupChatMemberBarProps {
  chatId: string
}

interface ContextMenuState {
  x: number
  y: number
  characterId: string
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
  const setGroupCharacterIds = useStore((s) => s.setGroupCharacterIds)
  const setMutedCharacterIds = useStore((s) => s.setMutedCharacterIds)
  const openModal = useStore((s) => s.openModal)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Close context menu on click outside, escape, or scroll
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        dismiss()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [contextMenu])

  // Adjust context menu position to stay within viewport
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const el = contextMenuRef.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (rect.right > vw - 8) {
      el.style.left = `${vw - rect.width - 8}px`
    }
    if (rect.bottom > vh - 8) {
      el.style.top = `${vh - rect.height - 8}px`
    }
  }, [contextMenu])

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

  const handleContextMenu = useCallback((e: React.MouseEvent, characterId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, characterId })
  }, [])

  const handleToggleMute = useCallback(
    async (characterId: string) => {
      setContextMenu(null)
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
        toggleMuteCharacter(characterId)
      }
    },
    [chatId, toggleMuteCharacter]
  )

  const handleRemoveMember = useCallback(
    (characterId: string) => {
      const char = characters.find((c) => c.id === characterId)
      setContextMenu(null)

      if (groupCharacterIds.length <= 2) {
        toast.warning('Cannot remove — group chats require at least 2 members')
        return
      }

      openModal('confirm', {
        title: 'Remove from Group',
        message: `Remove ${char?.name || 'this character'} from the group chat?`,
        variant: 'danger',
        confirmText: 'Remove',
        onConfirm: async () => {
          try {
            await chatsApi.removeMember(chatId, characterId)
            const newIds = groupCharacterIds.filter((id) => id !== characterId)
            setGroupCharacterIds(newIds)
            // Also clean up muted list locally
            if (mutedCharacterIds.includes(characterId)) {
              setMutedCharacterIds(mutedCharacterIds.filter((id) => id !== characterId))
            }
            toast.success(`${char?.name || 'Character'} removed from group`)
          } catch (err: any) {
            console.error('[GroupMemberBar] Remove member failed:', err)
            toast.error(err?.body?.error || 'Failed to remove member')
          }
        },
      })
    },
    [chatId, characters, groupCharacterIds, mutedCharacterIds, setGroupCharacterIds, setMutedCharacterIds, openModal]
  )

  const handleForceGenerateFromMenu = useCallback(
    (characterId: string) => {
      setContextMenu(null)
      handleForceGenerate(characterId)
    },
    [handleForceGenerate]
  )

  if (groupCharacterIds.length === 0) return null

  const contextIsMuted = contextMenu ? mutedCharacterIds.includes(contextMenu.characterId) : false

  return (
    <div className={styles.bar}>
      {groupCharacterIds.map((id) => {
        const char = characters.find((c) => c.id === id)
        const isActive = id === activeGroupCharacterId
        const isMuted = mutedCharacterIds.includes(id)
        const talk = char?.talkativeness ?? 0.5
        const avatarUrl = getCharacterAvatarThumbUrl(char)
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
            onContextMenu={(e) => handleContextMenu(e, id)}
            title={char?.name || 'Character'}
            disabled={isStreaming}
          >
            {char?.avatar_path || char?.image_id ? (
              <img
                src={avatarUrl || undefined}
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

      <button
        type="button"
        className={styles.addMemberBtn}
        onClick={() => openModal('addGroupMember', { chatId })}
        title="Add member to group"
      >
        <Plus size={16} />
      </button>

      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            type="button"
            className={styles.contextMenuItem}
            onClick={() => handleForceGenerateFromMenu(contextMenu.characterId)}
            disabled={isStreaming || contextIsMuted}
          >
            <Zap size={13} />
            <span>Force Generate</span>
          </button>
          <button
            type="button"
            className={styles.contextMenuItem}
            onClick={() => handleToggleMute(contextMenu.characterId)}
          >
            {contextIsMuted ? <Volume2 size={13} /> : <VolumeX size={13} />}
            <span>{contextIsMuted ? 'Unmute' : 'Mute'}</span>
          </button>
          <div className={styles.contextMenuDivider} />
          <button
            type="button"
            className={clsx(styles.contextMenuItem, styles.contextMenuItemDanger)}
            onClick={() => handleRemoveMember(contextMenu.characterId)}
          >
            <UserMinus size={13} />
            <span>Remove from Group</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
