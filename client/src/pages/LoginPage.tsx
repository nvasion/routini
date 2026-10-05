import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBanner, Field } from '../components/ui'
import { pickDefaultOrg, useAuth } from '../lib/auth'
import { useApi } from '../lib/hooks'

export function LoginPage() {
  const { session, login, signup } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const providers = useApi<{ oidc: { name: string } | null }>('/api/auth/providers')
  const callbackError = new URLSearchParams(location.search).get('error')
  const next = (location.state as { from?: string } | null)?.from ?? '/'
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState<string | null>(callbackError)
  const [busy, setBusy] = useState(false)

  if (session) {
    const org = pickDefaultOrg(session.orgs)
    return <Navigate to={org ? `/o/${org.slug}/inbox` : '/'} replace />
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const s =
        mode === 'login'
          ? await login(email, password)
          : await signup({ email, password, displayName: displayName || undefined, orgName: orgName || undefined })
      const org = pickDefaultOrg(s.orgs)
      navigate(org ? `/o/${org.slug}/inbox` : '/', { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card" style={{ padding: 24, gap: 16 }}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="brand-name">ROUTINI</span>
            <span className="brand-sub">AI ENGINEER · ON TYNHUB</span>
          </span>
        </div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" className="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button type="button" role="tab" className="tab" aria-selected={mode === 'signup'} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>
        {providers.data?.oidc && (
          <>
            <a className="btn primary sso" href={`/api/auth/oidc/start?next=${encodeURIComponent(next)}`}>
              Continue with {providers.data.oidc.name}
            </a>
            <div className="divider" role="separator">
              <span>or with email</span>
            </div>
          </>
        )}
        <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
          <Field label="Email">{(id) => <input id={id} className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
            {(id) => (
              <input
                id={id}
                className="input"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'signup' ? 8 : undefined}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          {mode === 'signup' && (
            <>
              <Field label="Your name">{(id) => <input id={id} className="input" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}</Field>
              <Field label="Org name" hint="Your workspace. You can create more later.">
                {(id) => <input id={id} className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} />}
              </Field>
            </>
          )}
          <ErrorBanner error={error} />
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  )
}
