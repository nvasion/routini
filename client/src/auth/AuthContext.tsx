import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  AuthApiError,
  fetchSession,
  login as loginRequest,
  logout as logoutRequest,
  type AuthUser,
} from './authApi'

interface AuthState {
  user: AuthUser | null
  loading: boolean
  error: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const current = await fetchSession()
        if (!cancelled) setUser(current)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load session')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setError(null)
    try {
      const loggedIn = await loginRequest(username, password)
      setUser(loggedIn)
    } catch (err) {
      const message =
        err instanceof AuthApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Login failed'
      setError(message)
      // Re-throw so the form can react (e.g. keep focus, avoid clearing input).
      throw err
    }
  }, [])

  const logout = useCallback(async () => {
    setError(null)
    try {
      await logoutRequest()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logout failed')
    } finally {
      // Always drop local state so a failed server call still lands the user
      // back at the login screen instead of leaving them stuck.
      setUser(null)
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const value = useMemo<AuthState>(
    () => ({ user, loading, error, login, logout, clearError }),
    [user, loading, error, login, logout, clearError],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return ctx
}
