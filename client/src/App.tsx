import { AuthProvider, useAuth } from './auth/AuthContext'
import { Dashboard } from './pages/Dashboard'
import { LoginPage } from './pages/Login'
import './App.css'

function AppShell() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="app">
        <p className="loading-splash">Loading…</p>
      </div>
    )
  }

  return user ? <Dashboard /> : <LoginPage />
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
