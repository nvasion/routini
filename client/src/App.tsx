/**
 * App root — sets up React Router and renders the appropriate page.
 *
 * Route structure:
 *   /login     — public login page (pages/Login.tsx)
 *   /          — protected dashboard  (pages/Dashboard.tsx)
 *   /settings  — protected AI settings (pages/Settings.tsx)
 *   *          — redirect to /
 *
 * Session architecture:
 *   - The JWT is stored in an HTTP-only, SameSite=Strict cookie set by the
 *     server. It is never accessible to JavaScript, protecting it from XSS.
 *   - A CSRF token is returned in the login response body and stored in
 *     sessionStorage. It is injected as X-CSRF-Token on every state-changing
 *     request by apiFetch (Double-Submit Cookie pattern).
 *   - getToken() returns the CSRF token as an auth-presence proxy: it is set
 *     on login and cleared on logout, mirroring the cookie lifecycle.
 *   - Expired sessions are handled centrally in apiFetch: a 401 response
 *     clears the CSRF token and redirects to /login automatically.
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'
import { getToken } from './api'

// ── Auth gate ─────────────────────────────────────────────────────────────────

interface ProtectedProps {
  children: React.ReactNode
}

/**
 * Wraps a page in an auth check. Redirects to /login when the CSRF token is
 * absent (meaning the user has not logged in or has logged out). The JWT itself
 * lives in an HTTP-only cookie and is never readable by JavaScript.
 * The Navbar is rendered inside protected routes so it appears on every
 * authenticated page without duplication in the route tree.
 */
function Protected({ children }: ProtectedProps) {
  if (!getToken()) {
    return <Navigate to="/login" replace />
  }
  return (
    <>
      <Navbar />
      {children}
    </>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route
          path="/"
          element={
            <Protected>
              <Dashboard />
            </Protected>
          }
        />

        <Route
          path="/settings"
          element={
            <Protected>
              <Settings />
            </Protected>
          }
        />

        {/* Catch-all → redirect to dashboard */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
