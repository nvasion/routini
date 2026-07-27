/**
 * IntegrationsPage — landing view for the `/integrations` route.
 *
 * Per the "Routini Integrations v1" PRD, this tab lets users connect the
 * external tools their tasks and coding agents work with (GitHub, Slack,
 * Jira, Notion, Linear, monday.com, HubSpot, ...). This task only wires up
 * the Navbar tab and the route itself — the catalog grid (status badges fed
 * by `GET /api/integrations`), the connect modal, and the test/disconnect
 * actions are built out in follow-up tasks. This placeholder keeps the route
 * reachable and visually consistent with the rest of the app in the
 * meantime, rather than leaving `/integrations` pointing at nothing.
 */
import './IntegrationsPage.css'

export function IntegrationsPage() {
  return (
    <div className="integrations-page">
      <header className="integrations-header">
        <div>
          <h1>Integrations</h1>
          <p className="integrations-subtitle">
            Connect the external tools your tasks and coding agents work with
          </p>
        </div>
      </header>

      <div className="integrations-placeholder">
        <p>No integrations catalog yet</p>
        <p className="integrations-placeholder-hint">
          GitHub, Slack, Jira, Notion, Linear, monday.com, and HubSpot connections are coming soon.
        </p>
      </div>
    </div>
  )
}
