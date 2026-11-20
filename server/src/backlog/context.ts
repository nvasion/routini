// ─────────────────────────────────────────────────────────────────────────────
// Builds the AdapterCtx a source adapter needs: credentials read through the
// org's connected integration, and fetch — the app's integration fetch test
// seam when one is wired (EngineOptions.actions.integrationFetch), else the
// runtime's global fetch. Contract: docs/work-intake-backlog.md section 7.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppContext } from '../http/common.js'
import { getIntegrationCredentials } from '../repos/integrations.js'
import type { FetchFn } from '../integrations/providers.js'
import type { AdapterCtx } from './types.js'

export function adapterCtx(app: AppContext, orgId: string): AdapterCtx {
  return {
    fetch: app.actions?.integrationFetch ?? (fetch as FetchFn),
    credentials: (integration) => app.db.org(orgId, (q) => getIntegrationCredentials(q, app.box, orgId, integration)),
  }
}
