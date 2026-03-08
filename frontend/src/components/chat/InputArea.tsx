import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { Send, RotateCw, CornerDownLeft, Square, FilePlus, Eye, UserCircle, Compass, MessageSquareQuote, Wrench, UserRound, UsersRound, Home, MoreHorizontal } from 'lucide-react'
import { useStore } from '@/store'
import { messagesApi, chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import { generateApi } from '@/api/generate'
import { personasApi } from '@/api/personas'
import { toast } from '@/lib/toast'
import { useDeviceFrameRadius } from '@/hooks/useDeviceFrameRadius'
import styles from './InputArea.module.css'
import clsx from 'clsx'
import InputBarExtensionActions from './InputBarExtensionActions'

interface InputAreaProps {
  chatId: string
}

export default function InputArea({ chatId }: InputAreaProps) {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [dryRunning, setDryRunning] = useState(false)
  const [openPopover, setOpenPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras'>(null)
  const [renderPopover, setRenderPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras'>(null)
  const [popoverClosing, setPopoverClosing] = useState(false)
  const [sendPersonaId, setSendPersonaId] = useState<string | null>(null)
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string; title: string; avatar_path: string | null; image_id: string | null }>>([])
  const [characterChats, setCharacterChats] = useState<Array<{ id: string; name: string; updated_at: number }>>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeGenerationId = useStore((s) => s.activeGenerationId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const enterToSend = useStore((s) => s.chatSheldEnterToSend)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const guidedGenerations = useStore((s) => s.guidedGenerations)
  const quickReplySets = useStore((s) => s.quickReplySets)
  const personas = useStore((s) => s.personas)
  const messages = useStore((s) => s.messages)
  const addMessage = useStore((s) => s.addMessage)
  const startStreaming = useStore((s) => s.startStreaming)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const openModal = useStore((s) => s.openModal)
  const setSetting = useStore((s) => s.setSetting)

  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)

  // iPhone-specific: match input bar bottom corners to device screen curvature
  const screenCornerRadius = useDeviceFrameRadius()
  const [inputFocused, setInputFocused] = useState(false)

  // Extra bottom padding to clear the curved corners (geometric: curve depth at content edge)
  const iphoneBottomPad = screenCornerRadius
    ? Math.round(screenCornerRadius * 0.3) + 8
    : 0

  const activeGuides = guidedGenerations.filter((g) => g.enabled)
  const activeGuideCount = activeGuides.length
  const activeQuickReplySets = quickReplySets.filter((s) => s.enabled)

  const consumeOneshotGuides = useCallback(() => {
    const next = guidedGenerations.map((g) =>
      g.mode === 'oneshot' && g.enabled ? { ...g, enabled: false } : g
    )
    if (next.some((g, i) => g.enabled !== guidedGenerations[i].enabled)) {
      setSetting('guidedGenerations', next)
    }
  }, [guidedGenerations, setSetting])

  useEffect(() => {
    if (openPopover) {
      setRenderPopover(openPopover)
      setPopoverClosing(false)
      return
    }
    if (!renderPopover) return
    setPopoverClosing(true)
    const timer = setTimeout(() => {
      setRenderPopover(null)
      setPopoverClosing(false)
    }, 220)
    return () => clearTimeout(timer)
  }, [openPopover, renderPopover])

  // ResizeObserver — set --lcs-input-safe-zone on parent so scroll padding stays in sync
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const parent = el.parentElement
    if (!parent) return

    const update = () => {
      const h = el.offsetHeight
      const bottomOffset = parseFloat(getComputedStyle(el).bottom) || 12
      parent.style.setProperty('--lcs-input-safe-zone', `${h + bottomOffset + 16}px`)
    }

    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [])

  // Document-level Escape to stop generation
  useEffect(() => {
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && isStreaming && activeGenerationId) {
        e.preventDefault()
        e.stopPropagation()
        generateApi.stop(activeGenerationId).catch(console.error)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isStreaming, activeGenerationId])

  useEffect(() => {
    if (openPopover !== 'persona') return
    if (personas.length > 0) {
      setPersonaList(personas.map((p) => ({ id: p.id, name: p.name, title: p.title || '', avatar_path: p.avatar_path, image_id: p.image_id })))
      return
    }
    personasApi.list({ limit: 200 }).then((res) => {
      setPersonaList(res.data.map((p) => ({ id: p.id, name: p.name, title: p.title || '', avatar_path: p.avatar_path, image_id: p.image_id })))
    }).catch(() => {})
  }, [openPopover, personas])

  useEffect(() => {
    if (!sendPersonaId) return
    if (personas.some((p) => p.id === sendPersonaId)) return
    setSendPersonaId(null)
  }, [sendPersonaId, personas])

  useEffect(() => {
    if (openPopover !== 'tools' || !activeCharacterId) return
    chatsApi.list({ characterId: activeCharacterId, limit: 25 }).then((res) => {
      setCharacterChats(res.data.map((c) => ({ id: c.id, name: c.name, updated_at: c.updated_at })))
    }).catch(() => {})
  }, [openPopover, activeCharacterId])

  const handleSend = useCallback(async () => {
    if (sendingRef.current || isStreaming) return
    const content = text.trim()

    sendingRef.current = true
    setText('')
    setStreamingError(null)

    // Reset textarea height
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.focus()
      }
    })

    try {
      const effectivePersonaId = sendPersonaId || activePersonaId
      const effectivePersonaName = personas.find((p) => p.id === effectivePersonaId)?.name || 'User'
      const genOpts: import('@/api/generate').GenerateRequest = {
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: effectivePersonaId || undefined,
        preset_id: activeLoomPresetId || undefined,
        generation_type: 'normal' as const,
      }
      // For group chats, let the backend pick the first speaker (or pass a specific one if forced)
      if (isGroupChat && groupCharacterIds.length > 0) {
        genOpts.target_character_id = groupCharacterIds[0]
      }
      if (content) {
        const msg = await messagesApi.create(chatId, {
          is_user: true,
          name: effectivePersonaName,
          content,
          extra: effectivePersonaId ? { persona_id: effectivePersonaId } : undefined,
        })
        // Optimistically add to store so it appears immediately
        addMessage(msg)
        const res = await generateApi.start(genOpts)
        startStreaming(res.generationId)
        consumeOneshotGuides()
        if (sendPersonaId) setSendPersonaId(null)
      } else {
        // Empty send = silent continue (nudge AI to generate)
        const res = await generateApi.continueGeneration(genOpts)
        startStreaming(res.generationId)
        consumeOneshotGuides()
      }
    } catch (err: any) {
      console.error('[InputArea] Failed to send:', err)
      const msg = err?.body?.error || err?.message || 'Failed to start generation'
      setStreamingError(msg)
      toast.error(msg, { title: 'Generation Failed' })
    } finally {
      sendingRef.current = false
    }
  }, [text, chatId, isStreaming, activeProfileId, activePersonaId, activeLoomPresetId, personas, sendPersonaId, addMessage, startStreaming, setStreamingError, consumeOneshotGuides])

  const handleRegenerate = useCallback(async () => {
    if (isStreaming) return
    // Find the last assistant message to regenerate
    let targetMessageId: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].is_user) {
        targetMessageId = messages[i].id
        break
      }
    }
    try {
      const res = await generateApi.regenerate({
        chat_id: chatId,
        message_id: targetMessageId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: activeLoomPresetId || undefined,
      })
      startStreaming(res.generationId, targetMessageId)
      consumeOneshotGuides()
    } catch (err: any) {
      console.error('[InputArea] Failed to regenerate:', err)
      const msg = err?.body?.error || err?.message || 'Failed to regenerate'
      setStreamingError(msg)
      toast.error(msg, { title: 'Regeneration Failed' })
    }
  }, [chatId, isStreaming, messages, activeProfileId, activePersonaId, activeLoomPresetId, startStreaming, setStreamingError, consumeOneshotGuides])

  const handleContinue = useCallback(async () => {
    if (isStreaming) return
    try {
      const res = await generateApi.continueGeneration({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: activeLoomPresetId || undefined,
      })
      startStreaming(res.generationId)
      consumeOneshotGuides()
    } catch (err: any) {
      console.error('[InputArea] Failed to continue:', err)
      const msg = err?.body?.error || err?.message || 'Failed to continue'
      setStreamingError(msg)
      toast.error(msg, { title: 'Continue Failed' })
    }
  }, [chatId, isStreaming, activeProfileId, activePersonaId, activeLoomPresetId, startStreaming, setStreamingError, consumeOneshotGuides])

  const handleImpersonate = useCallback(async () => {
    if (isStreaming) return
    try {
      const res = await generateApi.start({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: activeLoomPresetId || undefined,
        generation_type: 'impersonate',
      })
      startStreaming(res.generationId)
      consumeOneshotGuides()
    } catch (err: any) {
      console.error('[InputArea] Failed to impersonate:', err)
      const msg = err?.body?.error || err?.message || 'Failed to impersonate'
      setStreamingError(msg)
      toast.error(msg, { title: 'Impersonation Failed' })
    }
  }, [chatId, isStreaming, activeProfileId, activePersonaId, activeLoomPresetId, startStreaming, setStreamingError, consumeOneshotGuides])

  const handleStop = useCallback(async () => {
    if (!activeGenerationId) return
    try {
      await generateApi.stop(activeGenerationId)
    } catch (err) {
      console.error('[InputArea] Failed to stop:', err)
    }
  }, [activeGenerationId])

  const handleNewChat = useCallback(async () => {
    if (!activeCharacterId) return
    try {
      const character = await charactersApi.get(activeCharacterId)
      if (character.alternate_greetings?.length > 0) {
        openModal('greetingPicker', {
          character,
          onSelect: async (greetingIndex: number) => {
            try {
              const chat = await chatsApi.create({
                character_id: character.id,
                greeting_index: greetingIndex,
              })
              navigate(`/chat/${chat.id}`)
            } catch (err) {
              console.error('[InputArea] Failed to create chat:', err)
            }
          },
        })
        return
      }
      const chat = await chatsApi.create({ character_id: character.id })
      navigate(`/chat/${chat.id}`)
    } catch (err) {
      console.error('[InputArea] Failed to start new chat:', err)
    }
  }, [activeCharacterId, navigate, openModal])

  const handleDryRun = useCallback(async () => {
    if (dryRunning || isStreaming) return
    setDryRunning(true)
    try {
      const result = await generateApi.dryRun({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: activeLoomPresetId || undefined,
      })
      openModal('dryRun', result)
    } catch (err: any) {
      console.error('[InputArea] Dry run failed:', err)
      const msg = err?.body?.error || err?.message || 'Dry run failed'
      setStreamingError(msg)
    } finally {
      setDryRunning(false)
    }
  }, [chatId, dryRunning, isStreaming, activeProfileId, activePersonaId, activeLoomPresetId, openModal, setStreamingError])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        if (enterToSend) {
          if (!e.shiftKey) {
            e.preventDefault()
            handleSend()
          }
        } else {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            handleSend()
          }
        }
      }
    },
    [enterToSend, handleSend]
  )

  // Auto-resize textarea
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'
  }, [])

  const toggleGuide = useCallback((id: string) => {
    const next = guidedGenerations.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g))
    setSetting('guidedGenerations', next)
  }, [guidedGenerations, setSetting])

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={screenCornerRadius ? {
        borderRadius: inputFocused
          ? 'var(--lcs-radius, 14px)'
          : `var(--lcs-radius, 14px) var(--lcs-radius, 14px) ${screenCornerRadius}px ${screenCornerRadius}px`,
        ...(inputFocused ? {} : { paddingBottom: `${iphoneBottomPad}px` }),
      } : undefined}
    >
      {/* Action bar — hidden during streaming */}
      <div data-spindle-mount="chat_toolbar">
        {!isStreaming && (
          <div className={styles.actionBar}>
            <button type="button" className={styles.actionBtn} onClick={() => navigate('/')} title="Back to home">
              <Home size={14} />
            </button>
            <span className={styles.actionDivider} />
            <button type="button" className={styles.actionBtn} onClick={handleRegenerate} title="Regenerate">
              <RotateCw size={14} />
            </button>
            <button type="button" className={styles.actionBtn} onClick={handleContinue} title="Continue">
              <CornerDownLeft size={14} />
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'persona' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'persona' ? null : 'persona'))}
              title="Send next message as persona"
            >
              <UserCircle size={14} />
              {sendPersonaId && <span className={styles.badge}>1</span>}
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'guides' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'guides' ? null : 'guides'))}
              title="Guided generations"
            >
              <Compass size={14} />
              {activeGuideCount > 0 && <span className={styles.badge}>{activeGuideCount}</span>}
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'quick' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'quick' ? null : 'quick'))}
              title="Quick replies"
            >
              <MessageSquareQuote size={14} />
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'tools' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'tools' ? null : 'tools'))}
              title="Tools"
            >
              <Wrench size={14} />
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'extras' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'extras' ? null : 'extras'))}
              title="Extras"
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        )}
      </div>

      {activeGuideCount > 0 && (
        <div className={styles.guidePills}>
          {activeGuides.map((g) => (
            <button key={g.id} type="button" className={styles.guidePill} onClick={() => toggleGuide(g.id)}>
              {g.name}
            </button>
          ))}
        </div>
      )}

      <div className={clsx(styles.popoverSlot, openPopover && styles.popoverSlotOpen)}>
        <div className={styles.popoverSlotInner}>
          {renderPopover === 'guides' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {guidedGenerations.length === 0 && <div className={styles.popEmpty}>No guided generations configured.</div>}
              {guidedGenerations.map((g) => (
                <button key={g.id} type="button" className={styles.popRowBtn} onClick={() => toggleGuide(g.id)}>
                  <span>{g.name}</span>
                  <span className={styles.popMeta}>{g.enabled ? 'ON' : 'OFF'} • {g.mode}</span>
                </button>
              ))}
              <button type="button" className={styles.popLink} onClick={() => {
                setOpenPopover(null)
                useStore.getState().openSettings('guided')
              }}>Manage in settings</button>
            </div>
          )}

          {renderPopover === 'quick' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {activeQuickReplySets.length === 0 && <div className={styles.popEmpty}>No enabled quick reply sets.</div>}
              {activeQuickReplySets.map((set) => (
                <div key={set.id} className={styles.quickSet}>
                  <div className={styles.quickSetName}>{set.name}</div>
                  {set.replies.map((reply) => (
                    <button
                      key={reply.id}
                      type="button"
                      className={styles.popRowBtn}
                      onClick={() => {
                        setText(reply.message)
                        setOpenPopover(null)
                        requestAnimationFrame(() => textareaRef.current?.focus())
                      }}
                    >
                      <span>{reply.label || 'Untitled reply'}</span>
                    </button>
                  ))}
                </div>
              ))}
              <button type="button" className={styles.popLink} onClick={() => {
                setOpenPopover(null)
                useStore.getState().openSettings('quickReplies')
              }}>Manage in settings</button>
            </div>
          )}

          {renderPopover === 'persona' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {sendPersonaId && (
                <button
                  type="button"
                  className={styles.popLink}
                  onClick={() => {
                    setSendPersonaId(null)
                    setOpenPopover(null)
                  }}
                >
                  Clear one-shot persona
                </button>
              )}
              {personaList.length === 0 && <div className={styles.popEmpty}>No personas available.</div>}
              {personaList.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={clsx(styles.popRowBtn, sendPersonaId === p.id && styles.popRowBtnActive)}
                  onClick={() => {
                    setSendPersonaId(p.id)
                    setOpenPopover(null)
                  }}
                >
                  <span className={styles.personaMain}>
                    <span className={styles.personaAvatar}>
                      {p.avatar_path || p.image_id ? (
                        <img className={styles.personaAvatarImg} src={personasApi.avatarUrl(p.id)} alt={p.name} loading="lazy" />
                      ) : (
                        <span className={styles.personaFallback}>{p.name.slice(0, 1).toUpperCase()}</span>
                      )}
                    </span>
                    <span className={styles.personaNameGroup}>
                      <span>{p.name}</span>
                      {p.title && <span className={styles.personaTitle}>{p.title}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {renderPopover === 'tools' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <button
                type="button"
                className={styles.popRowBtn}
                onClick={() => {
                  setOpenPopover(null)
                  openModal('groupChatCreator')
                }}
              >
                <span className={styles.personaMain}>
                  <UsersRound size={14} />
                  <span>New Group Chat</span>
                </span>
              </button>
              <div className={styles.quickSetName}>Other chats for this character</div>
              {characterChats.filter((c) => c.id !== chatId).slice(0, 12).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    navigate(`/chat/${c.id}`)
                    setOpenPopover(null)
                  }}
                >
                  <span>{c.name || `Chat ${new Date(c.updated_at * 1000).toLocaleString()}`}</span>
                </button>
              ))}
              {characterChats.length <= 1 && <div className={styles.popEmpty}>No other chats yet.</div>}
            </div>
          )}

          {renderPopover === 'extras' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.extrasSection}>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleImpersonate()
                  }}
                >
                  <span className={styles.personaMain}>
                    <UserRound size={14} />
                    <span>Impersonate</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleNewChat()
                  }}
                >
                  <span className={styles.personaMain}>
                    <FilePlus size={14} />
                    <span>New Prompt</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleDryRun()
                  }}
                  disabled={dryRunning}
                  style={dryRunning ? { opacity: 0.5 } : undefined}
                >
                  <span className={styles.personaMain}>
                    <Eye size={14} />
                    <span>Dry Run</span>
                  </span>
                </button>
              </div>
              <InputBarExtensionActions onClose={() => setOpenPopover(null)} />
            </div>
          )}
        </div>
      </div>

      {/* Input row */}
      <div className={styles.inputRow}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Type a message..."
            rows={1}
            disabled={isStreaming}
          />
        </div>

        {isStreaming ? (
          <button
            type="button"
            className={clsx(styles.sendBtn, styles.sendBtnStop)}
            onClick={handleStop}
            title="Stop generation"
            aria-label="Stop generation"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            type="button"
            className={styles.sendBtn}
            onClick={handleSend}
            title={text.trim() ? 'Send message' : 'Silent continue (nudge)'}
            aria-label={text.trim() ? 'Send message' : 'Silent continue'}
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
