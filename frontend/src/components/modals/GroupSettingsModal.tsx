import { useState, useMemo, useCallback } from 'react'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { chatsApi } from '@/api/chats'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import type { Character } from '@/types/api'
import styles from './GroupChatCreatorModal.module.css'

export default function GroupSettingsModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps) as {
    chatId: string
    chatName?: string
    metadata: Record<string, any>
  } | null
  const characters = useStore((s) => s.characters)

  const chatId = modalProps?.chatId ?? ''
  const metadata = modalProps?.metadata ?? {}
  const characterIds: string[] = metadata.character_ids ?? []

  const selectedCharacters = useMemo(
    () => characterIds.map((id) => characters.find((c) => c.id === id)).filter(Boolean) as Character[],
    [characterIds, characters]
  )

  const [groupName, setGroupName] = useState(modalProps?.chatName ?? '')
  const [talkativenessOverrides, setTalkativenessOverrides] = useState<Record<string, number>>(
    metadata.talkativeness_overrides ?? {}
  )

  const existingOverride = metadata.group_scenario_override ?? {}
  const [scenarioMode, setScenarioMode] = useState<'individual' | 'member' | 'custom'>(
    existingOverride.mode ?? 'individual'
  )
  const [scenarioMemberId, setScenarioMemberId] = useState<string>(
    existingOverride.member_character_id ?? ''
  )
  const [scenarioCustom, setScenarioCustom] = useState(existingOverride.content ?? '')
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (saving || !chatId) return
    setSaving(true)
    try {
      const updatedMeta: Record<string, any> = {
        ...metadata,
        talkativeness_overrides: talkativenessOverrides,
      }
      if (scenarioMode !== 'individual') {
        updatedMeta.group_scenario_override = {
          mode: scenarioMode,
          ...(scenarioMode === 'member' && scenarioMemberId ? { member_character_id: scenarioMemberId } : {}),
          ...(scenarioMode === 'custom' ? { content: scenarioCustom } : {}),
        }
      } else {
        delete updatedMeta.group_scenario_override
      }
      await chatsApi.update(chatId, {
        name: groupName || undefined,
        metadata: updatedMeta,
      })
      closeModal()
    } catch (err) {
      console.error('[GroupSettings] Failed to save:', err)
    } finally {
      setSaving(false)
    }
  }, [saving, chatId, metadata, groupName, talkativenessOverrides, scenarioMode, scenarioMemberId, scenarioCustom, closeModal])

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={520}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />
      <div className={styles.header}>
        <h2 className={styles.title}>Group Settings</h2>
      </div>
      <div className={styles.body}>
        <div className={styles.settingsSection}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Group Name</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Enter group name..."
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Group Scenario</label>
            <select
              className={styles.fieldInput}
              value={scenarioMode === 'member' ? `member:${scenarioMemberId}` : scenarioMode}
              onChange={(e) => {
                const val = e.target.value
                if (val === 'individual') {
                  setScenarioMode('individual')
                  setScenarioMemberId('')
                } else if (val === 'custom') {
                  setScenarioMode('custom')
                  setScenarioMemberId('')
                } else if (val.startsWith('member:')) {
                  setScenarioMode('member')
                  setScenarioMemberId(val.slice(7))
                }
              }}
            >
              <option value="individual">Use individual scenarios</option>
              {selectedCharacters.map((char) => (
                <option key={char.id} value={`member:${char.id}`}>
                  Use {char.name}'s scenario
                </option>
              ))}
              <option value="custom">Custom scenario</option>
            </select>
            {scenarioMode === 'custom' && (
              <textarea
                className={styles.fieldInput}
                value={scenarioCustom}
                onChange={(e) => setScenarioCustom(e.target.value)}
                placeholder="Enter a shared scenario for the group..."
                rows={4}
                style={{ resize: 'vertical', marginTop: 8 }}
              />
            )}
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Talkativeness per Character</label>
            {selectedCharacters.map((char) => (
              <div key={char.id} className={styles.talkSlider}>
                {char.avatar_path || char.image_id ? (
                  <img
                    src={getCharacterAvatarThumbUrl(char) || undefined}
                    alt={char.name}
                    className={styles.talkAvatar}
                  />
                ) : (
                  <span className={styles.talkAvatarFallback}>
                    {char.name[0]?.toUpperCase()}
                  </span>
                )}
                <span className={styles.talkName}>{char.name}</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={talkativenessOverrides[char.id] ?? 0.5}
                  onChange={(e) =>
                    setTalkativenessOverrides((prev) => ({
                      ...prev,
                      [char.id]: parseFloat(e.target.value),
                    }))
                  }
                  className={styles.talkRange}
                />
                <span className={styles.talkValue}>
                  {(talkativenessOverrides[char.id] ?? 0.5).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <Button variant="ghost" onClick={closeModal}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
          Save
        </Button>
      </div>
    </ModalShell>
  )
}
