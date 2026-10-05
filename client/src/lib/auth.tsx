// Session state: who is signed in and which orgs they belong to.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, setCsrfToken } from './api'
import type { OrgRef, Session } from './types'

interface AuthState {
  session: Session | null
  loading: boolean
  login(email: string, password: string): Promise<Session>
  signup(input: { email: string; password: string; displayName?: string; orgName?: string }): Promise<Session>
  logout(): Promise<void>
  refresh(): Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const s = await api<Session>('/api/auth/me')
      if (s.csrfToken) setCsrfToken(s.csrfToken)
      setSession(s)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setSession(null)
      else throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => setLoading(false))
  }, [refresh])

  const accept = (s: Session & { csrfToken?: string }) => {
    setCsrfToken(s.csrfToken)
    setSession({ user: s.user, orgs: s.orgs })
    return s
  }

  const value: AuthState = {
    session,
    loading,
    refresh,
    login: async (email, password) => accept(await api<Session>('/api/auth/login', { body: { email, password } })),
    signup: async (input) => accept(await api<Session>('/api/auth/signup', { body: input })),
    logout: async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
      setCsrfToken(null)
      setSession(null)
    },
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}

const LAST_ORG = 'routini.lastOrg'
export function rememberOrg(slug: string): void {
  try {
    localStorage.setItem(LAST_ORG, slug)
  } catch {
    // ignore
  }
}
export function pickDefaultOrg(orgs: OrgRef[]): OrgRef | undefined {
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST_ORG)
  } catch {
    last = null
  }
  return orgs.find((o) => o.slug === last) ?? orgs[0]
}
