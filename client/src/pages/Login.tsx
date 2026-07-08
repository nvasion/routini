import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'

export function LoginPage() {
  const { login, error, clearError, loading: sessionLoading } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      await login(username, password)
    } catch {
      // The AuthContext already surfaced the error; keep the form mounted so
      // the user can retry without retyping the username.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">routini</h1>
        <p className="login-subtitle">Sign in to continue</p>

        <form onSubmit={handleSubmit} className="login-form" aria-label="Login form">
          <label className="login-label" htmlFor="login-username">
            Username
            <input
              id="login-username"
              className="login-input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => {
                clearError()
                setUsername(event.target.value)
              }}
              disabled={submitting || sessionLoading}
              required
            />
          </label>

          <label className="login-label" htmlFor="login-password">
            Password
            <input
              id="login-password"
              className="login-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                clearError()
                setPassword(event.target.value)
              }}
              disabled={submitting || sessionLoading}
              required
            />
          </label>

          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="login-submit"
            disabled={submitting || sessionLoading}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
