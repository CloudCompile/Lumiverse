import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { useDesktopWidgetRuntime } from '@/ws/useDesktopWidgetRuntime'
import { useThemeApplicator } from '@/hooks/useThemeApplicator'
import { useCustomCSSApplicator } from '@/hooks/useCustomCSSApplicator'
import { initializeSafeThemeMode } from '@/lib/safeThemeMode'
import { installDisplayPerformanceTelemetry, markDisplayInteractive, markDisplayMilestone } from '@/lib/displayPerformance'
import DesktopFloatingWidgetHost from '@/components/spindle/DesktopFloatingWidgetHost'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import { desktopFloatingWidgetTarget } from '@/lib/desktop-floating-widget'
import './theme/variables.css'
import './theme/reset.css'
import './theme/global.css'

installDisplayPerformanceTelemetry('desktop-widget')

function DesktopWidgetRuntime() {
  const phase = useDesktopWidgetRuntime(desktopFloatingWidgetTarget)
  useThemeApplicator()
  useCustomCSSApplicator()
  if (!desktopFloatingWidgetTarget) return null

  const extensionAvailable = phase === 'ready'
    ? true
    : phase === 'unavailable'
      ? false
      : null
  return <DesktopFloatingWidgetHost extensionAvailable={extensionAvailable} />
}

document.documentElement.setAttribute('data-tauri-desktop', '')
document.documentElement.setAttribute('data-tauri-floating-widget', '')

void Promise.all([initI18n(), initializeSafeThemeMode()]).then(() => {
  markDisplayMilestone('render-scheduled')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary label="Desktop widget">
        <DesktopWidgetRuntime />
      </ErrorBoundary>
    </StrictMode>,
  )
  markDisplayInteractive()
})
