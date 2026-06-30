import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from 'lucide-react'
import { IconApps } from '@tabler/icons-react'
import { useStore } from '@/store'
import useIsMobile from '@/hooks/useIsMobile'
import { resolveDockPanelEdge } from '@/lib/spindle/dock-placement'
import styles from './SpindleUIControlPanel.module.css'
import clsx from 'clsx'

export default function SpindleUIControlPanel() {
  const { t } = useTranslation('shared', { keyPrefix: 'spindle' })
  const drawerTabs = useStore((s) => s.drawerTabs)
  const floatWidgets = useStore((s) => s.floatWidgets)
  const dockPanels = useStore((s) => s.dockPanels)
  const appMounts = useStore((s) => s.appMounts)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)
  const togglePlacementVisibility = useStore((s) => s.togglePlacementVisibility)
  const showAllPlacements = useStore((s) => s.showAllPlacements)
  const hideAllPlacements = useStore((s) => s.hideAllPlacements)
  const dockPanelDesktopSide = useStore((s) => s.spindleSettings.dockPanelDesktopSide)
  const isMobile = useIsMobile()

  const allItems = [
    ...drawerTabs.map((tab) => ({ id: tab.id, label: tab.title, kind: t('drawerTab'), ext: tab.extensionId })),
    ...floatWidgets.map((w) => ({ id: w.id, label: w.tooltip || t('floatWidget'), kind: t('floatWidget'), ext: w.extensionId })),
    ...dockPanels.map((p) => ({
      id: p.id,
      label: p.title,
      kind: t('dockPanel', { edge: resolveDockPanelEdge(p.edge, dockPanelDesktopSide, isMobile) }),
      ext: p.extensionId,
    })),
    ...appMounts.map((m) => ({ id: m.id, label: t('appMount'), kind: t('appMount'), ext: m.extensionId })),
  ]

  if (allItems.length === 0) return null

  const hiddenCount = allItems.filter((i) => hiddenPlacements.includes(i.id)).length

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <IconApps size={13} />
        <span className={styles.headerLabel}>{t('extensionUi', { count: allItems.length })}</span>
        <div className={styles.headerActions}>
          <button className={styles.smallBtn} onClick={showAllPlacements} title={t('showAll')}>
            <Eye size={12} /> {t('show')}
          </button>
          <button className={styles.smallBtn} onClick={hideAllPlacements} title={t('hideAll')}>
            <EyeOff size={12} /> {t('hide')}
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {allItems.map((item) => {
          const isHidden = hiddenPlacements.includes(item.id)
          return (
            <div key={item.id} className={clsx(styles.item, isHidden && styles.itemHidden)}>
              <div className={styles.itemInfo}>
                <span className={styles.itemLabel}>{item.label}</span>
                <span className={styles.itemMeta}>{item.kind}</span>
              </div>
              <button
                className={styles.toggleBtn}
                onClick={() => togglePlacementVisibility(item.id)}
                title={isHidden ? t('show') : t('hide')}
              >
                {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
