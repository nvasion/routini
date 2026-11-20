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

const INTEGRATION_LABEL: Record<'monday' | 'github', { name: string; field: string }> = {
  monday: { name: 'monday.com', field: 'apiToken' },
  github: { name: 'GitHub', field: 'token' },
}

/**
 * Throws a message a person can act on when the source's integration isn't connected,
 * instead of letting the tracker answer "Not authenticated" or "Bad credentials".
 */
export async function requireConnected(ctx: AdapterCtx, integration: 'monday' | 'github'): Promise<void> {
  const { name, field } = INTEGRATION_LABEL[integration]
  const creds = await ctx.credentials(integration)
  if (!creds[field]) throw new Error(`The ${name} integration is not connected (Integrations → ${name})`)
}
