// Frame for the public pages (landing, getting started): a top bar with the
// brand and the way in, and a footer. Follows the selected theme.

import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Mark } from '../../components/Brand'
import { useAuth } from '../../lib/auth'
import { useApi } from '../../lib/hooks'
import { THEMES, useTheme } from '../../lib/theme'

export const REPO_URL = 'https://github.com/nvasion/routini'
export const RUNNER_REPO_URL = 'https://github.com/nvasion/routini-runner'

export function useSignupOpen(): boolean | null {
  const p = useApi<{ signupOpen?: boolean }>('/api/auth/providers')
  return p.data ? p.data.signupOpen !== false : null
}

export function PublicLayout({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const signupOpen = useSignupOpen()
  const { theme, setTheme } = useTheme()
  return (
    <div className="public">
      <header className="public-nav">
        <Link className="brand" to="/" aria-label="Routini home">
          <Mark size={32} />
          <span className="brand-name" style={{ fontSize: 21 }}>
            ROUTINI
          </span>
        </Link>
        <nav className="public-links" aria-label="Site">
          <NavLink to="/docs/getting-started">Getting started</NavLink>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <div className="public-actions">
          {session ? (
            <Link className="btn primary" to="/app">
              Open console
            </Link>
          ) : (
            <>
              <Link className="btn" to="/login">
                Sign in
              </Link>
              {signupOpen !== false && (
                <Link className="btn primary" to="/signup">
                  Get started
                </Link>
              )}
            </>
          )}
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="public-footer">
        <div className="public-footer-inner">
          <span className="inline" style={{ gap: 8 }}>
            <Mark size={22} />
            <span>Routini · part of the TynHub network</span>
          </span>
          <span className="public-footer-links">
            <Link to="/docs/getting-started">Getting started</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Source (AGPL-3.0)
            </a>
            <a href={RUNNER_REPO_URL} target="_blank" rel="noreferrer">
              routini-runner (Apache-2.0)
            </a>
          </span>
          <div className="segmented" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </footer>
    </div>
  )
}
