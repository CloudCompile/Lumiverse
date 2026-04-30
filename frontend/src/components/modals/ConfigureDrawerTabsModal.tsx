import { useMemo } from 'react'
import clsx from 'clsx'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { Toggle } from '@/components/shared/Toggle'
import { CloseButton } from '@/components/shared/CloseButton'
import { DRAWER_TABS, adaptExtensionTabs, isDrawerTabCore, sanitizeHiddenDrawerTabIds, type DrawerTabEntry } from '@/lib/drawer-tab-registry'
import styles from './ConfigureDrawerTabsModal.module.css'

interface TabSectionProps {
  title: string
  description: string
  tabs: DrawerTabEntry[]
  hiddenTabIds: Set<string>
  onToggle: (tabId: string, enabled: boolean) => void
}

function TabSection({ title, description, tabs, hiddenTabIds, onToggle }: TabSectionProps) {
  if (tabs.length === 0) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <p className={styles.sectionDescription}>{description}</p>
      </div>

      <div className={styles.list}>
        {tabs.map((tab) => {
          const Icon = tab.tabIcon
          const locked = isDrawerTabCore(tab.id)
          const enabled = !hiddenTabIds.has(tab.id)

          return (
            <div key={tab.id} className={clsx(styles.row, locked && styles.rowLocked)}>
              <div className={styles.rowInfo}>
                <span className={styles.iconWrap}>
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <div className={styles.copy}>
                  <div className={styles.rowTitleWrap}>
                    <span className={styles.rowTitle}>{tab.tabName}</span>
                    {locked && <span className={styles.badge}>Core</span>}
                  </div>
                  <p className={styles.rowDescription}>
                    {locked ? 'Always visible so you can still reach core app sections.' : tab.tabDescription}
                  </p>
                </div>
              </div>

              <Toggle.Switch
                checked={enabled}
                onChange={(next) => onToggle(tab.id, next)}
                disabled={locked}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function ConfigureDrawerTabsModal() {
  const closeModal = useStore((s) => s.closeModal)
  const setSetting = useStore((s) => s.setSetting)
  const drawerSettings = useStore((s) => s.drawerSettings)
  const drawerTabs = useStore((s) => s.drawerTabs)

  const hiddenTabIds = useMemo(
    () => new Set(sanitizeHiddenDrawerTabIds(drawerSettings.hiddenTabIds)),
    [drawerSettings.hiddenTabIds],
  )

  const extensionTabs = useMemo(() => adaptExtensionTabs(drawerTabs), [drawerTabs])
  const coreTabs = DRAWER_TABS.filter((tab) => isDrawerTabCore(tab.id))
  const optionalBuiltInTabs = DRAWER_TABS.filter((tab) => !isDrawerTabCore(tab.id))

  const handleToggle = (tabId: string, enabled: boolean) => {
    if (isDrawerTabCore(tabId)) return
    const nextHidden = new Set(hiddenTabIds)
    if (enabled) nextHidden.delete(tabId)
    else nextHidden.add(tabId)
    setSetting('drawerSettings', {
      ...drawerSettings,
      hiddenTabIds: Array.from(nextHidden),
    })
  }

  return (
    <ModalShell isOpen onClose={closeModal} maxWidth={720} className={styles.modal}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />

      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Configure Tabs</h3>
          <p className={styles.subtitle}>Choose which optional sidebar tabs stay visible. Core tabs always remain available.</p>
        </div>
      </div>

      <div className={styles.body}>
        <TabSection
          title="Core Tabs"
          description="Pinned so you always have a path back into the main app surfaces."
          tabs={coreTabs}
          hiddenTabIds={hiddenTabIds}
          onToggle={handleToggle}
        />

        <TabSection
          title="Optional Tabs"
          description="Hide sections you do not use often and bring them back here later if needed."
          tabs={optionalBuiltInTabs}
          hiddenTabIds={hiddenTabIds}
          onToggle={handleToggle}
        />

        <TabSection
          title="Extension Tabs"
          description="Extension-provided tabs can be shown or hidden independently from the built-in ones."
          tabs={extensionTabs}
          hiddenTabIds={hiddenTabIds}
          onToggle={handleToggle}
        />
      </div>
    </ModalShell>
  )
}
