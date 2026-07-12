import { useState, useEffect, useCallback } from 'react'
import { AuthProvider, useAuth } from './AuthContext'
import LoginPage from './LoginPage'
import './App.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Item {
  id: number
  name: string
  createdAt: string
}

// ── Dashboard (shown when authenticated) ──────────────────────────────────────

// Safe HTTP methods that do not mutate server state and therefore do not
// require a CSRF token per the HTTP spec (RFC 9110 §9.2.1).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

function Dashboard() {
  const { user, logout, csrfToken } = useAuth()
  const [items, setItems] = useState<Item[]>([])
  const [newItemName, setNewItemName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  /**
   * Wraps fetch with:
   *  1. Automatic CSRF token injection for state-changing methods (POST, DELETE, …).
   *     The token is sent as X-CSRF-Token and validated by the server against the
   *     value embedded in the session JWT (Synchronizer Token Pattern).
   *  2. Automatic 401 detection — expired sessions are logged out so AuthGate
   *     redirects to the login page cleanly.
   */
  const guardFetch = useCallback(
    async (url: string, init?: RequestInit): Promise<Response | null> => {
      const method = (init?.method ?? 'GET').toUpperCase()

      // Inject CSRF token for all state-changing (non-safe) requests.
      const csrfHeaders: HeadersInit =
        !SAFE_METHODS.has(method) && csrfToken
          ? { 'X-CSRF-Token': csrfToken }
          : {}

      const res = await fetch(url, {
        ...init,
        credentials: 'include',
        headers: { ...init?.headers, ...csrfHeaders },
      })

      if (res.status === 401) {
        // Session expired — clear local state so AuthGate shows LoginPage
        await logout()
        return null
      }
      return res
    },
    [logout, csrfToken],
  )

  // Fetch items on mount. Uses guardFetch so an expired session is handled.
  useEffect(() => {
    const load = async () => {
      try {
        const res = await guardFetch('/api/items')
        if (res === null) return // session expired, already logged out
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setItems(data.items)
      } catch (err) {
        if (import.meta.env.DEV) {
          console.error('[dashboard] Failed to fetch items:', err)
        }
        setError('Failed to fetch items')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [guardFetch])

  const addItem = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newItemName.trim() || isSubmitting) return

    setIsSubmitting(true)
    setError(null)
    try {
      const res = await guardFetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newItemName }),
      })
      if (res === null) return // session expired
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const newItem = await res.json()
      setItems(prev => [...prev, newItem])
      setNewItemName('')
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error('[dashboard] Failed to add item:', err)
      }
      setError('Failed to add item')
    } finally {
      setIsSubmitting(false)
    }
  }

  const deleteItem = async (id: number) => {
    if (isSubmitting) return

    setIsSubmitting(true)
    setError(null)
    try {
      const res = await guardFetch(`/api/items/${id}`, { method: 'DELETE' })
      if (res === null) return // session expired
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setItems(prev => prev.filter(item => item.id !== id))
    } catch (err) {
      if (import.meta.env.DEV) {
        console.error('[dashboard] Failed to delete item:', err)
      }
      setError('Failed to delete item')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (loading) return <div className="app"><p>Loading…</p></div>

  return (
    <div className="app">
      <header className="header">
        <h1>routini</h1>
        <p>A full-stack TypeScript application</p>
        <div className="header-actions">
          <span className="user-info">Signed in as <strong>{user?.username}</strong></span>
          <button onClick={logout} className="logout-btn">Sign Out</button>
        </div>
      </header>

      <main className="main">
        {error && <p className="error">{error}</p>}

        <form onSubmit={addItem} className="form">
          <input
            type="text"
            value={newItemName}
            onChange={e => setNewItemName(e.target.value)}
            placeholder="Enter item name"
            className="input"
            disabled={isSubmitting}
          />
          <button type="submit" className="button" disabled={isSubmitting}>
            Add Item
          </button>
        </form>

        <ul className="list">
          {items.map(item => (
            <li key={item.id} className="list-item">
              <span>{item.name}</span>
              <button
                onClick={() => deleteItem(item.id)}
                className="delete-btn"
                disabled={isSubmitting}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>

        {items.length === 0 && <p className="empty">No items yet. Add one above!</p>}
      </main>
    </div>
  )
}

// ── Auth gate — renders LoginPage or Dashboard based on session state ──────────

function AuthGate() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="app">
        <p style={{ textAlign: 'center', marginTop: '4rem', color: '#666' }}>
          Loading…
        </p>
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  return <Dashboard />
}

// ── Root component ────────────────────────────────────────────────────────────

function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  )
}

export default App
