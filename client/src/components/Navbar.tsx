import { Link, useLocation, useNavigate } from 'react-router-dom'
import { getToken, clearToken, apiFetch } from '../api'
import './Navbar.css'

export function Navbar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const isLoggedIn = Boolean(getToken())

  const handleLogout = async () => {
    // Best-effort — clear local state even if the network call fails.
    // apiFetch sends credentials:'include' (cookie) and the X-CSRF-Token
    // header automatically, satisfying the server's CSRF protection.
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Network error — fall through to clear local token anyway
    }
    clearToken() // remove CSRF token from sessionStorage
    navigate('/login')
  }

  const navLink = (to: string, label: string) => (
    <li key={to}>
      <Link to={to} className={`nav-link${pathname === to ? ' active' : ''}`}>
        {label}
      </Link>
    </li>
  )

  return (
    <nav className="navbar" aria-label="Main navigation">
      <div className="navbar-brand">
        <Link to="/" className="navbar-logo">
          routini
        </Link>
      </div>

      {isLoggedIn && (
        <ul className="navbar-links" role="list">
          {navLink('/', 'Dashboard')}
          {navLink('/settings', 'Settings')}
        </ul>
      )}

      <div className="navbar-actions">
        {isLoggedIn ? (
          <button className="btn btn-outline" onClick={handleLogout}>
            Sign Out
          </button>
        ) : (
          <Link to="/login" className="btn btn-outline">
            Login
          </Link>
        )}
      </div>
    </nav>
  )
}
