import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: number
  username: string
}

interface AuthContextValue {
  user: AuthUser | null
  /**
   * CSRF token returned by the server alongside the session JWT.
   * Must be sent as the `X-CSRF-Token` header on all state-changing
   * requests (POST, PUT, PATCH, DELETE). This implements the
   * Synchronizer Token Pattern: the token is bound to the JWT so it
   * cannot be used after logout or session expiry.
   */
  csrfToken: string | null
  loading: boolean
  /** Makes the POST /api/auth/login call, sets user on success, throws on failure. */
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null)

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // On mount: check whether a valid session already exists. The HTTP-only
  // cookie is sent automatically by the browser — we cannot read it from JS.
  // The /api/auth/me response also returns the CSRF token so we can re-sync
  // the in-memory token after a page refresh.
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then((data: { user: AuthUser; csrfToken: string } | null) => {
        if (data?.user) {
          setUser(data.user)
          setCsrfToken(data.csrfToken ?? null)
        }
      })
      .catch((err: unknown) => {
        // Network error or server unavailable — treat user as not logged in.
        if (import.meta.env.DEV) {
          console.warn('[auth] Session check failed:', err)
        }
      })
      .finally(() => setLoading(false))
  }, [])

  /**
   * Calls POST /api/auth/login. On success the server sets an HTTP-only
   * cookie, returns the user object, and returns a CSRF token. Throws with
   * the server's error message on failure so the LoginPage can surface it.
   */
  const login = async (username: string, password: string): Promise<void> => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // required to receive the HttpOnly cookie
      body: JSON.stringify({ username, password }),
    })

    const data = await res.json()

    if (!res.ok) {
      throw new Error(data.error ?? 'Login failed. Please try again.')
    }

    setUser(data.user as AuthUser)
    setCsrfToken((data.csrfToken as string) ?? null)
  }

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      })
    } catch (err: unknown) {
      // Network failure — still clear client state so the user isn't stuck.
      if (import.meta.env.DEV) {
        console.warn('[auth] Logout request failed:', err)
      }
    } finally {
      setUser(null)
      setCsrfToken(null)
    }
  }

  return (
    <AuthContext.Provider value={{ user, csrfToken, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>')
  return ctx
}
