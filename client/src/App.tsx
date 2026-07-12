import { Component, useCallback, useState, type ErrorInfo, type ReactNode } from 'react'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { AppHeader, type AppPage } from './components/AppHeader'
import { Dashboard } from './pages/Dashboard'
import { LoginPage } from './pages/Login'
import { AiSettingsPage } from './pages/AiSettings'
import { RoutineBuilderPage } from './pages/RoutineBuilder'
import './App.css'

// ---------------------------------------------------------------------------
// Error Boundary
//
// Catches render-time errors (e.g. unexpected undefined from an API response
// reaching a .map() call) and shows a recovery UI instead of crashing the
// whole React tree. Uses a class component because React only supports
// getDerivedStateFromError / componentDidCatch on class components.
// ---------------------------------------------------------------------------

interface ErrorBoundaryState {
  hasError: boolean
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log the full detail for debugging without exposing it to the UI
    // (avoids leaking implementation details or PII to end users).
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="app">
          <p className="error" role="alert">
            Something went wrong. Please{' '}
            <button
              type="button"
              className="button"
              onClick={() => this.setState({ hasError: false })}
            >
              try again
            </button>{' '}
            or reload the page.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

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
      ) : page === 'routine-builder' ? (
        <RoutineBuilderPage />
      ) : (
        <AiSettingsPage onDone={() => goto('dashboard')} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </ErrorBoundary>
  )
}
