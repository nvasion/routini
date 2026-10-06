// Signed-out account pages: forgot password, choose a new password (from the
// emailed link), and verify an email address (from the emailed link).

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBanner, Field } from '../components/ui'
import { Mark } from '../components/Brand'
import { api } from '../lib/api'
import { pickDefaultOrg, useAuth } from '../lib/auth'

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="card auth-card" style={{ padding: 24, gap: 16 }}>
        <div className="auth-brand">
          <Mark size={64} label="Routini" />
          <span className="brand-name" style={{ fontSize: 26 }}>
            {title}
          </span>
        </div>
        {children}
      </div>
      <Link className="auth-back" to="/login">
        ← Back to sign in
      </Link>
    </div>
  )
}

const useToken = () => new URLSearchParams(useLocation().search).get('token') ?? ''

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setSent((await api<{ message: string }>('/api/auth/password/forgot', { body: { email } })).message)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Reset password">
      {sent ? (
        <div className="banner info" role="status">
          {sent} The link works for 30 minutes.
        </div>
      ) : (
        <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
          <p className="muted" style={{ margin: 0 }}>
            Enter the email you sign in with and we'll send you a link to choose a new password.
          </p>
          <Field label="Email">{(id) => <input id={id} className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <ErrorBanner error={error} />
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthCard>
  )
}

export function ResetPasswordPage() {
  const token = useToken()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(token ? null : 'This reset link is incomplete. Request a new one.')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError("The passwords don't match")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('/api/auth/password/reset', { body: { token, password } })
      navigate('/login', { replace: true, state: { notice: 'Password changed. Sign in with your new password.' } })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="New password">
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <Field label="New password" hint="At least 8 characters. You'll be signed out everywhere.">
          {(id) => <input id={id} className="input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field label="Repeat it">
          {(id) => <input id={id} className="input" type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <ErrorBanner error={error} />
        {error && /expired|incomplete/.test(error) && (
          <Link to="/forgot-password" className="muted">
            Request a new link
          </Link>
        )}
        <button type="submit" className="btn primary" disabled={busy || !token}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </AuthCard>
  )
}

export function VerifyEmailPage() {
  const token = useToken()
  const { session, refresh } = useAuth()
  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed')
  const [error, setError] = useState<string | null>(token ? null : 'This verification link is incomplete.')
  const started = useRef(false)

  useEffect(() => {
    // Once: a token is single-use, and StrictMode runs effects twice in development.
    if (!token || started.current) return
    started.current = true
    api('/api/auth/email/verify', { body: { token } })
      .then(async () => {
        setState('done')
        await refresh().catch(() => {})
      })
      .catch((err: Error) => {
        setError(err.message)
        setState('failed')
      })
  }, [token, refresh])

  const org = session ? pickDefaultOrg(session.orgs) : undefined
  return (
    <AuthCard title="Verify email">
      {state === 'working' && <p className="muted">Verifying…</p>}
      {state === 'done' && (
        <>
          <div className="banner info" role="status">
            Your email is verified. Agents and environments are unlocked.
          </div>
          <Link className="btn primary" to={org ? `/o/${org.slug}/inbox` : '/login'}>
            {org ? 'Open the console' : 'Sign in'}
          </Link>
        </>
      )}
      {state === 'failed' && (
        <>
          <ErrorBanner error={error} />
          <p className="muted" style={{ margin: 0 }}>
            {session ? 'Send a new link from Settings → Account.' : 'Sign in, then send a new link from Settings → Account.'}
          </p>
        </>
      )}
    </AuthCard>
  )
}
