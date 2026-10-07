// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Teams action: post a message to a channel through the org's
// connected Workflows webhook (see integrations/teams.ts for the URL
// validation and Adaptive Card payload shared with the "test connection" check).
// ─────────────────────────────────────────────────────────────────────────────

import { getIntegrationCredentials } from '../repos/integrations.js'
import { postTeamsMessage, validateTeamsWebhookUrl } from '../integrations/teams.js'
import type { FetchFn } from '../integrations/providers.js'
import type { ActionConfig } from './spec.js'
import type { StepContext, StepResult } from './types.js'

export async function runTeamsAction(
  ctx: StepContext,
  cfg: Extract<ActionConfig, { type: 'teams' }>,
  opts: { fetchImpl?: FetchFn } = {},
): Promise<StepResult> {
  const creds = await ctx.app.db.org(ctx.org.id, (q) => getIntegrationCredentials(q, ctx.app.box, ctx.org.id, 'teams'))
  if (!creds['webhookUrl']) {
    return { status: 'failed', error: 'The Microsoft Teams integration is not connected (Integrations -> Microsoft Teams)' }
  }
  const webhookUrl = creds['webhookUrl']
  ctx.addSecret(webhookUrl)

  try {
    validateTeamsWebhookUrl(webhookUrl)
  } catch (err) {
    return { status: 'failed', error: (err as Error).message }
  }

  let r: { ok: boolean; status: number }
  try {
    r = await postTeamsMessage(webhookUrl, { text: cfg.message, title: cfg.title }, { fetchImpl: opts.fetchImpl, signal: ctx.signal })
  } catch (err) {
    if (ctx.signal.aborted) throw err
    if (err instanceof Error && err.name === 'AbortError') return { status: 'failed', error: 'Microsoft Teams did not answer in time' }
    return { status: 'failed', error: 'Could not reach the Teams webhook' }
  }

  if (!r.ok) return { status: 'failed', error: `Teams webhook returned status ${r.status}` }
  await ctx.log('Posted to Microsoft Teams')
  return { status: 'succeeded', output: { posted: true } }
}
