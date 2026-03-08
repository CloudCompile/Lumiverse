import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { registerSW } from 'virtual:pwa-register'
import { router } from './router'
import './theme/variables.css'
import './theme/reset.css'
import './theme/global.css'

// Register service worker for PWA support — autoUpdate reloads on new versions
registerSW({ immediate: true })

// Flag standalone PWA mode for CSS targeting
if (window.matchMedia('(display-mode: standalone)').matches) {
  document.documentElement.setAttribute('data-pwa', '')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
