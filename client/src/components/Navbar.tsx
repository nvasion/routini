import { Link, useLocation } from 'react-router-dom'
import './Navbar.css'

export function Navbar() {
  const { pathname } = useLocation()

  const navLink = (to: string, label: string) => (
    <li>
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

      <ul className="navbar-links" role="list">
        {navLink('/', 'Dashboard')}
        {navLink('/settings', 'Settings')}
      </ul>

      <div className="navbar-actions">
        <Link to="/login" className="btn btn-outline">
          Login
        </Link>
      </div>
    </nav>
  )
}
