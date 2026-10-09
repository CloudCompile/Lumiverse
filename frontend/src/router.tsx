import { createBrowserRouter, Outlet } from 'react-router'
import App from './App'
import LandingPage from './components/landing/LandingPage'
import ChatView from './components/chat/ChatView'
import CharacterBrowser from './components/panels/CharacterBrowser'
import CharacterProfile from './components/panels/CharacterProfile'
import LoginPage from './components/auth/LoginPage'
import SsoCompletePage from './components/auth/SsoCompletePage'
import OAuthConsentPage from './components/auth/OAuthConsentPage'
import StreamDeckHandoffPage from './components/StreamDeckHandoffPage'
import DesktopPwaTitlebar from './components/shared/DesktopPwaTitlebar'
import { isDesktopFloatingWidgetWindow } from './lib/desktop-floating-widget'

function WindowShell() {
  return (
    <>
      {!isDesktopFloatingWidgetWindow() && <DesktopPwaTitlebar />}
      <Outlet />
    </>
  )
}

const routes = [
  {
    element: <WindowShell />,
    children: [
      {
        path: '/login',
        element: <LoginPage />,
      },
      {
        path: '/sso-complete',
        element: <SsoCompletePage />,
      },
      {
        path: '/oauth/consent',
        element: <OAuthConsentPage />,
      },
      {
        path: '/stream-deck/open/chat/:chatId',
        element: <StreamDeckHandoffPage />,
      },
      {
        path: '/',
        element: <App />,
        children: [
          { index: true, element: <LandingPage /> },
          { path: 'chat/:chatId', element: <ChatView /> },
          { path: 'characters', element: <CharacterBrowser /> },
          { path: 'characters/:id', element: <CharacterProfile /> },
        ],
      },
    ],
  },
]

export const router = createBrowserRouter(routes)
