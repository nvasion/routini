// ─────────────────────────────────────────────────────────────────────────────
// Factory action: start an orchestration (or a PRD execution) on Factory and
// wait for it, streaming progress into the run timeline.
//
// Factory API (factory-api/internal/api/routes.go):
//   POST /api/projects/:id/orchestrate   { request, runtime?, provider?, model?, post_completion? } → Orchestration
//   POST /api/prds/:id/execute           {}                                                      → { orchestration_id }
//   GET  /api/orchestrations/:id?view=compact → { orchestration: { status, completed_tasks, total_tasks,
//                                                  failed_tasks, failure_reason, pr_url } }
// Status: pending | decomposing | running | completed | failed. Factory sends no
// completion webhook, so we poll. Auth: Authorization: Bearer fk_…
// ─────────────────────────────────────────────────────────────────────────────

import { getIntegrationCredentials } from '../repos/integrations.js'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'
import type { ActionConfig } from './spec.js'
import type { StepContext, StepResult } from './types.js'

export type FactoryFetch = (url: string, init: RequestInit) => Promise<Response>
export const DEFAULT_FACTORY_URL = 'https://factory-nexus.ai'

interface Orchestration {
  id?: string
  status?: string
  completed_tasks?: number
  total_tasks?: number
  failed_tasks?: number
  failure_reason?: string | null
  pr_url?: string | null
}

export async function runFactoryAction(
  ctx: StepContext,
  cfg: Extract<ActionConfig, { type: 'factory' }>,
  opts: { fetchImpl?: FactoryFetch; pollMs?: number } = {},
): Promise<StepResult> {
  const creds = await ctx.app.db.org(ctx.org.id, (q) => getIntegrationCredentials(q, ctx.app.box, ctx.org.id, 'factory'))
  if (!creds['apiToken']) return { status: 'failed', error: 'The Factory integration is not connected (Integrations → Factory)' }
  ctx.addSecret(creds['apiToken'])

  let base: URL
  try {
    base = new URL(creds['baseUrl'] || DEFAULT_FACTORY_URL)
  } catch {
    return { status: 'failed', error: 'The Factory URL in the integration is not valid' }
  }
  if (ctx.app.config.mode !== 'selfhost') {
    const safe = isSsrfSafeHostname(base.hostname) && (await resolvedIpIsSsrfSafe(base.hostname).catch(() => false))
    if (!safe) return { status: 'failed', error: 'The Factory URL points at a private address' }
  }

  const fetchImpl = opts.fetchImpl ?? (fetch as FactoryFetch)
  const pollMs = opts.pollMs ?? 10_000
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const onAbort = () => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetchImpl(new URL(path, base).toString(), {
        method,
        signal: controller.signal,
        redirect: 'manual',
        headers: { authorization: `Bearer ${creds['apiToken']}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!res.ok) {
        const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`
        throw new Error(`Factory ${method} ${path} failed: ${msg}`)
      }
      return data as T
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  // ── Start ────────────────────────────────────────────────────────────────
  let orchestrationId: string
  try {
    if (cfg.operation === 'orchestrate') {
      const created = await call<Orchestration>('POST', `/api/projects/${encodeURIComponent(cfg.projectId!)}/orchestrate`, {
        request: cfg.request,
        ...(cfg.runtime ? { runtime: cfg.runtime } : {}),
        ...(cfg.provider ? { provider: cfg.provider } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.createPr ? { post_completion: { push: true, create_pr: true } } : {}),
      })
      if (!created?.id) throw new Error('Factory did not return an orchestration id')
      orchestrationId = created.id
      await ctx.log(`Started Factory orchestration ${orchestrationId} on project ${cfg.projectId}`)
    } else {
      const started = await call<{ orchestration_id?: string; count?: number }>('POST', `/api/prds/${encodeURIComponent(cfg.prdId!)}/execute`, {})
      if (!started?.orchestration_id) throw new Error('Factory did not return an orchestration id for the PRD')
      orchestrationId = started.orchestration_id
      await ctx.log(`Started Factory PRD ${cfg.prdId} (${started.count ?? '?'} tasks) as orchestration ${orchestrationId}`)
    }
  } catch (err) {
    if (ctx.signal.aborted) return { status: 'failed', error: 'Canceled before Factory accepted the work' }
    return { status: 'failed', error: (err as Error).message }
  }

  // ── Poll ─────────────────────────────────────────────────────────────────
  let last = ''
  for (;;) {
    if (ctx.signal.aborted) {
      return { status: 'failed', error: `Routini stopped waiting; orchestration ${orchestrationId} continues in Factory`, output: { orchestrationId } }
    }
    let o: Orchestration | undefined
    try {
      o = (await call<{ orchestration?: Orchestration }>('GET', `/api/orchestrations/${encodeURIComponent(orchestrationId)}?view=compact`))?.orchestration
    } catch (err) {
      if (ctx.signal.aborted) continue
      await ctx.log(`Could not read orchestration status (will retry): ${(err as Error).message}`)
    }
    if (o) {
      const progress = `${o.status} · ${o.completed_tasks ?? 0}/${o.total_tasks ?? '?'} tasks${o.failed_tasks ? ` · ${o.failed_tasks} failed` : ''}`
      if (progress !== last) {
        await ctx.log(`Factory: ${progress}`)
        last = progress
      }
      const output = { orchestrationId, status: o.status, completedTasks: o.completed_tasks ?? 0, totalTasks: o.total_tasks ?? 0, prUrl: o.pr_url ?? null }
      if (o.status === 'completed') {
        if (o.pr_url) await ctx.emit('artifact', { kind: 'pull_request', url: o.pr_url, source: 'factory' })
        return { status: 'succeeded', output }
      }
      if (o.status === 'failed') return { status: 'failed', error: `Factory orchestration failed${o.failure_reason ? `: ${o.failure_reason}` : ''}`, output }
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs)
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve()
      }, { once: true })
    })
  }
}
