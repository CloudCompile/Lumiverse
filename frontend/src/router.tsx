import { createBrowserRouter } from 'react-router'
import App from './App'
import LandingPage from './components/landing/LandingPage'
import ChatView from './components/chat/ChatView'
import CharacterBrowser from './components/panels/CharacterBrowser'
import CharacterProfile from './components/panels/CharacterProfile'
import LoginPage from './components/auth/LoginPage'
import SignupPage from './components/auth/SignupPage'
import VerifyEmailPage from './components/auth/VerifyEmailPage'

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/signup',
    element: <SignupPage />,
  },
  {
    path: '/verify-email',
    element: <VerifyEmailPage />,
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
])
