import { useCallback, useState } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { AppHeader, type AppPage } from './components/AppHeader'
import { Dashboard } from './pages/Dashboard'
import { LoginPage } from './pages/Login'
import { AiSettingsPage } from './pages/AiSettings'
import './App.css'

function AppShell() {
  const { user, loading } = useAuth()
  const [page, setPage] = useState<AppPage>('dashboard')

  const goto = useCallback((next: AppPage) => setPage(next), [])

  if (loading) {
    return (
      <div className="app">
        <p className="loading-splash">Loading…</p>
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  return (
    <div className="app">
      <AppHeader activePage={page} onNavigate={goto} />
      {page === 'dashboard' ? (
        <Dashboard />
      ) : (
        <AiSettingsPage onDone={() => goto('dashboard')} />
      )}
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
