// ─────────────────────────────────────────────────────────────────────────────
// Factory action: start an orchestration, a PRD execution, or a swarm task on
// Factory and wait for it, streaming progress into the run timeline.
//
// Factory API (factory-api/internal/api/routes.go):
//   POST /api/projects/:id/orchestrate   { request, runtime?, provider?, model?, post_completion? } → Orchestration
//   POST /api/prds/:id/execute           {}                                                      → { orchestration_id }
//   GET  /api/orchestrations/:id?view=compact → { orchestration: { status, completed_tasks, total_tasks,
//                                                  failed_tasks, failure_reason, pr_url } }
//   POST /api/projects/:id/swarm/tasks   { prompt, branch_prefix, max_retries?, runtime?, provider?, model? } → { id }
//   GET  /api/swarm/tasks/:id            → { status, failure_reason }
//   GET  /api/projects/:id/git           → { branch, remote_url }
//   GET  /api/projects/:id/git/export/manifest?base=&head= → { head, totals: { commits, files } }
// Status: pending | decomposing | running | completed | failed (orchestration);
// queued | running | merged | failed | cancelled (swarm task). Factory sends no
// completion webhook, so we poll. Auth: Authorization: Bearer fk_…
//
// For task, from-step, or whenever `repoUrl` is set, the project's git state is
// read before dispatch (to pin a base commit, and to check the project builds
// the expected repo) and after success (to report what changed); failures there
// fail the step. A plain orchestrate/prd never reads git state, and never gets
// an `output.factory`.
// ─────────────────────────────────────────────────────────────────────────────

import { getIntegrationCredentials } from '../repos/integrations.js'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'
import type { ActionConfig } from './spec.js'
import type { StepContext, StepResult } from './types.js'

export type FactoryFetch = (url: string, init: RequestInit) => Promise<Response>
export const DEFAULT_FACTORY_URL = 'https://factory-nexus.ai'

type FactoryConfig = Extract<ActionConfig, { type: 'factory' }>
type FactoryCall = <T>(method: string, path: string, body?: unknown) => Promise<T>

interface Orchestration {
  id?: string
  status?: string
  completed_tasks?: number
  total_tasks?: number
  failed_tasks?: number
  failure_reason?: string | null
  pr_url?: string | null
}

interface SwarmTask {
  id?: string
  status?: string
  failure_reason?: string | null
}

interface GitStatus {
  branch?: string
  remote_url?: string
}

interface GitManifest {
  head?: string
  totals?: { commits?: number; files?: number }
}

/** Sleeps `ms`, or returns early (without throwing) if the step is canceled first. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * `owner/repo`-style path from either an `https://host/owner/repo(.git)` URL or
 * scp-like `git@host:owner/repo.git`, lowercased; `null` if unparseable.
 */
function repoOwnerName(raw: string): string | null {
  const scp = /^[\w.-]+@[^/:]+:(.+)$/.exec(raw.trim())
  let path: string
  if (scp) {
    path = scp[1]!
  } else {
    try {
      path = new URL(raw).pathname.replace(/^\//, '')
    } catch {
      return null
    }
  }
  const cleaned = path.replace(/\.git\/?$/i, '').replace(/\/+$/, '')
  return cleaned ? cleaned.toLowerCase() : null
}

async function fetchGitStatus(call: FactoryCall, projectId: string): Promise<GitStatus> {
  return call<GitStatus>('GET', `/api/projects/${encodeURIComponent(projectId)}/git`)
}

async function fetchGitManifest(call: FactoryCall, projectId: string, base: string, head: string): Promise<GitManifest> {
  return call<GitManifest>('GET', `/api/projects/${encodeURIComponent(projectId)}/git/export/manifest?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`)
}

/**
 * Before dispatch, when git reads are required (task, from-step, or `repoUrl`
 * set): checks the project builds `repoUrl` (if set) and pins the current head
 * of its branch as the diff base. A plain orchestrate/PRD never calls this —
 * its git state is simply not read, and `output.factory` is never added.
 */
async function resolveBaseRef(call: FactoryCall, cfg: FactoryConfig): Promise<{ baseRef: string } | { error: string }> {
  try {
    const git = await fetchGitStatus(call, cfg.projectId!)
    if (cfg.repoUrl) {
      const want = repoOwnerName(cfg.repoUrl)
      const have = git.remote_url ? repoOwnerName(git.remote_url) : null
      if (!have || want !== have) {
        return { error: `Factory project ${cfg.projectId} builds ${git.remote_url ?? 'an unknown repository'}, but this step expects ${cfg.repoUrl}` }
      }
    }
    if (!git.branch) throw new Error('Factory did not report a branch for this project')
    const manifest = await fetchGitManifest(call, cfg.projectId!, git.branch, git.branch)
    if (!manifest.head) throw new Error('Factory did not report a base commit for this project')
    return { baseRef: manifest.head }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/**
 * After success, when `baseRef` was pinned: reports what changed on the
 * project's branch since then, added as `output.factory`. Fails the step if
 * nothing changed, or if these (required) git reads themselves fail.
 */
async function finishWithFactoryOutput(
  call: FactoryCall,
  cfg: FactoryConfig,
  kind: 'task' | 'orchestration',
  id: string,
  baseRef: string | undefined,
  baseOutput: Record<string, unknown>,
): Promise<StepResult> {
  if (baseRef === undefined) return { status: 'succeeded', output: baseOutput }
  try {
    const git = await fetchGitStatus(call, cfg.projectId!)
    if (!git.branch) throw new Error('Factory did not report a branch for this project')
    const manifest = await fetchGitManifest(call, cfg.projectId!, baseRef, git.branch)
    if (!manifest.head) throw new Error('Factory did not report a head commit for this project')
    const commits = manifest.totals?.commits ?? 0
    const files = manifest.totals?.files ?? 0
    if (files === 0) return { status: 'failed', error: 'Factory finished, but its branch has no changes since dispatch', output: baseOutput }
    return {
      status: 'succeeded',
      output: { ...baseOutput, factory: { projectId: cfg.projectId, kind, id, baseRef, headRef: git.branch, headSha: manifest.head, commits, files } },
    }
  } catch (err) {
    return { status: 'failed', error: (err as Error).message, output: baseOutput }
  }
}

export async function runFactoryAction(ctx: StepContext, cfg: FactoryConfig, opts: { fetchImpl?: FactoryFetch; pollMs?: number } = {}): Promise<StepResult> {
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
  const call: FactoryCall = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
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

  // Git reads are required (their failure fails the step) for task, for a from-step
  // step (whatever it resolved to), and whenever repoUrl is set; otherwise best-effort.
  const gitRequired = cfg.operation !== 'prd' && (cfg.operation === 'task' || cfg.operationFrom !== undefined || cfg.repoUrl !== undefined)

  // ── Git status, repo check, base ref (before dispatch) ─────────────────────
  let baseRef: string | undefined
  if (gitRequired) {
    const resolved = await resolveBaseRef(call, cfg)
    if ('error' in resolved) return { status: 'failed', error: resolved.error }
    baseRef = resolved.baseRef
  }

  // ── Start ────────────────────────────────────────────────────────────────
  let orchestrationId: string | undefined
  let taskId: string | undefined
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
    } else if (cfg.operation === 'task') {
      const created = await call<SwarmTask>('POST', `/api/projects/${encodeURIComponent(cfg.projectId!)}/swarm/tasks`, {
        prompt: cfg.request,
        branch_prefix: 'routini/',
        ...(cfg.maxRetries !== undefined ? { max_retries: cfg.maxRetries } : {}),
        ...(cfg.runtime ? { runtime: cfg.runtime } : {}),
        ...(cfg.provider ? { provider: cfg.provider } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
      })
      if (!created?.id) throw new Error('Factory did not return a task id')
      taskId = created.id
      await ctx.log(`Started Factory task ${taskId} on project ${cfg.projectId}`)
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

  // ── Poll: swarm task ─────────────────────────────────────────────────────
  if (taskId) {
    let last = ''
    for (;;) {
      if (ctx.signal.aborted) {
        return { status: 'failed', error: `Routini stopped waiting; task ${taskId} continues in Factory`, output: { taskId } }
      }
      let task: SwarmTask | undefined
      try {
        task = await call<SwarmTask>('GET', `/api/swarm/tasks/${encodeURIComponent(taskId)}`)
      } catch (err) {
        if (ctx.signal.aborted) continue
        await ctx.log(`Could not read task status (will retry): ${(err as Error).message}`)
      }
      if (task?.status) {
        if (task.status !== last) {
          await ctx.log(`Factory task: ${task.status}`)
          last = task.status
        }
        if (task.status === 'merged') {
          return finishWithFactoryOutput(call, cfg, 'task', taskId, baseRef, { taskId, status: task.status })
        }
        if (task.status === 'failed' || task.status === 'cancelled') {
          return { status: 'failed', error: `Factory task failed${task.failure_reason ? `: ${task.failure_reason}` : ''}` }
        }
      }
      await wait(pollMs, ctx.signal)
    }
  }

  // ── Poll: orchestration (orchestrate & prd) ─────────────────────────────
  let last = ''
  for (;;) {
    if (ctx.signal.aborted) {
      return { status: 'failed', error: `Routini stopped waiting; orchestration ${orchestrationId} continues in Factory`, output: { orchestrationId } }
    }
    let o: Orchestration | undefined
    try {
      o = (await call<{ orchestration?: Orchestration }>('GET', `/api/orchestrations/${encodeURIComponent(orchestrationId!)}?view=compact`))?.orchestration
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
        if (cfg.operation === 'orchestrate') return finishWithFactoryOutput(call, cfg, 'orchestration', orchestrationId!, baseRef, output)
        return { status: 'succeeded', output }
      }
      if (o.status === 'failed') return { status: 'failed', error: `Factory orchestration failed${o.failure_reason ? `: ${o.failure_reason}` : ''}`, output }
    }
    await wait(pollMs, ctx.signal)
  }
}
