import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setCsrfToken } from '../api'
import './Login.css'

export function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const DEMO_EMAIL = 'admin@routini.dev'
  const DEMO_PASSWORD = 'changeme'

  const fillDemo = () => {
    setEmail(DEMO_EMAIL)
    setPassword(DEMO_PASSWORD)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedEmail = email.trim()
    const trimmedPassword = password.trim()

    if (!trimmedEmail || !trimmedPassword) {
      setError('Email and password are required')
      return
    }

    try {
      setLoading(true)
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password: trimmedPassword }),
      })

      const data = (await res.json()) as {
        token?: string
        csrfToken?: string
        user?: object
        error?: string
      }

      if (!res.ok) {
        setError(data.error ?? 'Login failed')
        return
      }

      // The server sets the JWT in an HTTP-only cookie automatically.
      // Store the CSRF token (returned in the response body) in sessionStorage
      // so apiFetch can include it as X-CSRF-Token on state-changing requests.
      if (data.csrfToken) {
        setCsrfToken(data.csrfToken)
      }
      navigate('/')
    } catch {
      setError('Network error – please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <header className="login-header">
          <h1 className="login-logo">routini</h1>
          <p className="login-tagline">Autonomous Engineer Platform</p>
        </header>

        <form onSubmit={handleSubmit} className="login-form" noValidate>
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@routini.dev"
              autoComplete="email"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-hint">
          Demo credentials:{' '}
          <button
            type="button"
            className="login-hint-fill"
            onClick={fillDemo}
            aria-label="Fill demo credentials"
          >
            <strong>{DEMO_EMAIL}</strong> / <strong>{DEMO_PASSWORD}</strong>
          </button>
        </p>
      </div>
    </div>
  )
}
