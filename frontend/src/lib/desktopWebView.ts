/** Whether this document is running in any native Tauri desktop shell. */
export function isTauriDesktop(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.hasAttribute('data-tauri-desktop')
}

/** Whether this document is running in the macOS Tauri WKWebView shell. */
export function isMacTauriWebView(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  return isTauriDesktop()
    && root.getAttribute('data-platform') === 'macos'
}
