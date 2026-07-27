// ─────────────────────────────────────────────────────────────────────────────
// Integrations API router
//
// Exposes the v1 integrations catalog (GitHub, Slack, Jira, Notion, Linear,
// monday.com, HubSpot) — see server/src/services/integrations.ts for the
// catalog definitions and status derivation.
//
// Routes:
//   GET /api/integrations – catalog + per-integration status/connectedAt/
//     lastTest/scopes. Read-only; requires authentication only (no CSRF,
//     matching the other GET-only routers in this codebase).
//
// PUT/POST(test)/DELETE (credential write, connection test, disconnect) are
// implemented by later tasks in the Routini Integrations PRD and will be
// added to this router alongside their own requireCsrf-guarded handlers.
//
// Security properties:
//   – Never returns secrets. The service layer only surfaces presence
//     (booleans) and timestamps derived from credential-row metadata; the
//     encrypted secret value is never read or decrypted by this route.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express'
import { requireAuth } from './auth.js'
import { getIntegrationSummaries } from '../services/integrations.js'

export const integrationsRouter = Router()

// Every endpoint requires a valid authenticated user, mirroring credentialsRouter.
integrationsRouter.use(requireAuth)

// ── GET /api/integrations ───────────────────────────────────────────────────
//
// Returns the full catalog with live status for each integration. Never
// includes credential material.

integrationsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ integrations: getIntegrationSummaries() })
})
