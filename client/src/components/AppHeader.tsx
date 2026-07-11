/**
 * Shared top-of-page header used by every authenticated screen.
 *
 * Provides:
 *  - Branding + signed-in user display.
 *  - Tab-style navigation between the dashboard and the AI Settings page.
 *  - The `Log out` action.
 *
 * The header is a controlled component: it owns no navigation state itself;
 * the shell in `App.tsx` decides which page is active and passes the value +
 * a callback down. That keeps this component trivially rerender-safe and
 * easy to unit-test in isolation.
 */

import { useAuth } from '../auth/AuthContext'

export type AppPage = 'dashboard' | 'routine-builder' | 'ai-settings'

interface AppHeaderProps {
  activePage: AppPage
  onNavigate: (page: AppPage) => void
}

const TABS: Array<{ id: AppPage; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'routine-builder', label: 'Routine Builder' },
  { id: 'ai-settings', label: 'AI Settings' },
]

export function AppHeader({ activePage, onNavigate }: AppHeaderProps) {
  const { user, logout } = useAuth()

  return (
    <header className="header">
      <div className="header-inner">
        <div>
          <h1>routini</h1>
          <p>Signed in as {user?.username}</p>
        </div>
        <nav aria-label="Primary" className="header-nav">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={
                tab.id === activePage ? 'nav-btn nav-btn-active' : 'nav-btn'
              }
              aria-current={tab.id === activePage ? 'page' : undefined}
              onClick={() => onNavigate(tab.id)}
            >
              {tab.label}
            </button>
          ))}
          <button type="button" className="logout-btn" onClick={logout}>
            Log out
          </button>
        </nav>
      </div>
    </header>
  )
}
