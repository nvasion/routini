import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, pickDefaultOrg, useAuth } from './lib/auth'
import { ThemeProvider } from './lib/theme'
import { DockWindow, OrgShell } from './shell/Shell'
import { LoginPage } from './pages/LoginPage'
import { InboxPage } from './pages/InboxPage'
import { RunsPage } from './pages/RunsPage'
import { RunPage } from './pages/RunPage'
import { JobsPage } from './pages/JobsPage'
import { JobEditorPage } from './pages/JobEditorPage'
import { IntegrationsPage } from './pages/IntegrationsPage'
import { SettingsPage } from './pages/SettingsPage'
import { EnvironmentsPage } from './pages/EnvironmentsPage'
import { FleetPage } from './pages/FleetPage'
import { IncidentPage, IncidentsPage } from './pages/IncidentsPage'
import { LandingPage } from './pages/public/LandingPage'
import { GettingStartedPage } from './pages/public/GettingStartedPage'
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/AccountPages'

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

/** `/`: the front page for visitors; signed-in people go straight to their console. */
function Front() {
  const { session, loading } = useAuth()
  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>
  return session ? <Home /> : <LandingPage />
}

function Home() {
  const { session } = useAuth()
  const org = session ? pickDefaultOrg(session.orgs) : undefined
  if (!org) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">You are not a member of any org yet. Ask an admin to add you.</div>
      </div>
    )
  }
  return <Navigate to={`/o/${org.slug}/inbox`} replace />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<LoginPage initialMode="signup" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/docs/getting-started" element={<GettingStartedPage />} />
      <Route path="/" element={<Front />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <Home />
          </RequireAuth>
        }
      />
      <Route
        path="/o/:org/dock"
        element={
          <RequireAuth>
            <DockWindow />
          </RequireAuth>
        }
      />
      <Route
        path="/o/:org"
        element={
          <RequireAuth>
            <OrgShell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="inbox" replace />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:run" element={<RunPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/new" element={<JobEditorPage />} />
        <Route path="jobs/:id" element={<JobEditorPage />} />
        <Route path="environments" element={<EnvironmentsPage />} />
        <Route path="fleet" element={<FleetPage />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="incidents/:number" element={<IncidentPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:tab" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
