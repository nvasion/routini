// ─────────────────────────────────────────────────────────────────────────────
// Routini as an MCP server (Streamable HTTP, stateless): POST /mcp
//
// Authenticated with an API token (`rtk_…`), which pins the session to one org
// and a role (the lower of the token's and its owner's). Tools follow the
// console's rules: viewers read, members run. Commands go through org policy
// and approvals like any run; approving is deliberately not a tool, so an
// agent can never approve its own work. Results are compact text built from
// stored (already redacted) data.
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { AppContext } from '../http/common.js'
import type { Auth } from '../http/auth.js'
import { getMembershipRole, getOrgById, roleAtLeast, type Org, type Role, type User } from '../repos/identity.js'
import { minRole, type ApiToken } from '../repos/apiTokens.js'
import { ensureAdhocJob, getJob, isHiddenJob, listJobs } from '../repos/jobs.js'
import { listHosts, type Host } from '../repos/hosts.js'
import { createRun, getRunByNumber, listEvents, listPendingApprovals, listRuns, listSteps, TERMINAL_RUN, type Run, type RunStatus } from '../repos/runs.js'
import { addIncidentEvent, getIncidentByNumber, listIncidentEvents, listIncidentRuns, listIncidents, resolveIncident } from '../repos/incidents.js'
import { cancelRun, RunStateError } from '../engine/runControl.js'
import { draftPostmortem } from '../routes/incidents.js'
import { evaluatePolicy, stepFacts } from '../engine/policy.js'
import { getPolicy } from '../repos/policy.js'
import type { Step } from '../engine/spec.js'

const VERSION = '0.4.0'

interface McpAuth {
  user: User
  org: Org
  role: Role
  token: ApiToken
}

class ToolError extends Error {}

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] })
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true })

/** Wraps a tool body: role check, ToolError → isError result. */
function tool<A>(auth: McpAuth, min: Role, fn: (args: A) => Promise<string>) {
  return async (args: A): Promise<CallToolResult> => {
    if (!roleAtLeast(auth.role, min)) return fail(`This needs the ${min} role; this token acts as ${auth.role}.`)
    try {
      return text(await fn(args))
    } catch (err) {
      if (err instanceof ToolError || err instanceof RunStateError) return fail(err.message)
      console.error('[mcp] tool failed:', (err as Error).message)
      return fail('Routini could not complete that request.')
    }
  }
}

const ago = (iso: string | null) => {
  if (!iso) return '—'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}

function hostLine(h: Host): string {
  const state =
    h.transport === 'runner'
      ? h.runner && !h.runner.revoked
        ? h.runner.online
          ? 'online'
          : `offline (seen ${ago(h.runner.lastSeenAt)})`
        : 'runner removed'
      : h.lastCheck
        ? h.lastCheck.ok
          ? 'reachable'
          : `unreachable: ${h.lastCheck.error ?? ''}`
        : 'not checked'
  const c = h.lastCheck
  const health = c?.ok ? ` · disk ${c.diskUsedPct ?? '?'}% · mem ${c.memUsedPct ?? '?'}%` : ''
  return `- ${h.name} [${h.transport}] ${state}${health}${h.group ? ` · group ${h.group}` : ''}${h.tags.length ? ` · tags ${h.tags.join(',')}` : ''}`
}

function outputSummary(output: unknown): string {
  if (!output || typeof output !== 'object') return ''
  const o = output as Record<string, unknown>
  const parts: string[] = []
  if (typeof o['exitCode'] === 'number') parts.push(`exit ${o['exitCode']}`)
  if (typeof o['statusCode'] === 'number') parts.push(`HTTP ${o['statusCode']}`)
  if (typeof o['summary'] === 'string') parts.push(`summary: ${o['summary']}`)
  if (o['pullRequest'] && typeof o['pullRequest'] === 'object') parts.push(`PR ${(o['pullRequest'] as { url?: string }).url ?? ''}`)
  return parts.join(' · ')
}

async function describeRun(ctx: AppContext, orgId: string, run: Run, logLines = 30): Promise<string> {
  const [steps, events, approvals] = await ctx.db.org(orgId, async (q) => [
    await listSteps(q, orgId, run.id),
    await listEvents(q, orgId, run.id, 0, 2000),
    (await listPendingApprovals(q, orgId)).filter((a) => a.runId === run.id),
  ] as const)
  const out = [`Run #${run.number} · ${run.jobSnapshot.name} · ${run.status} · trigger ${run.trigger.kind} · started ${ago(run.startedAt ?? run.createdAt)}`]
  if (run.error) out.push(`Error: ${run.error}`)
  out.push('Steps:')
  for (const s of steps) {
    const extra = [outputSummary(s.output), s.error ? `error: ${s.error}` : ''].filter(Boolean).join(' · ')
    out.push(`  ${s.idx + 1}. ${s.name} (${s.kind}) — ${s.status}${extra ? ` · ${extra}` : ''}`)
    const stdout = s.output && typeof s.output === 'object' ? (s.output as Record<string, unknown>)['stdout'] : undefined
    if (typeof stdout === 'string' && stdout.trim()) out.push(`     stdout:\n${stdout.trimEnd().split('\n').slice(-40).map((l) => `       ${l}`).join('\n')}`)
  }
  for (const a of approvals) out.push(`Waiting for approval (${a.minRole}+): ${a.message}. A person approves it in Routini; agents cannot.`)
  const logs = events.filter((e) => e.type === 'log' || e.type === 'agent.result' || e.type === 'egress.blocked').slice(-logLines)
  if (logs.length) {
    out.push(`Last ${logs.length} log lines:`)
    for (const e of logs) out.push(`  ${e.type === 'log' ? String(e.data['message'] ?? '') : `[${e.type}] ${JSON.stringify(e.data)}`}`)
  }
  return out.join('\n')
}

async function waitForRun(ctx: AppContext, orgId: string, runId: string, number: number, ms: number): Promise<Run> {
  const deadline = Date.now() + ms
  for (;;) {
    const run = (await ctx.db.org(orgId, (q) => getRunByNumber(q, orgId, number)))!
    if (TERMINAL_RUN.includes(run.status) || run.status === 'waiting' || Date.now() > deadline) return run
    await new Promise((r) => setTimeout(r, 300))
  }
}

export function buildMcpServer(ctx: AppContext, auth: McpAuth, opts: { commandWaitMs?: number } = {}): McpServer {
  const server = new McpServer(
    { name: 'routini', version: VERSION },
    {
      instructions:
        `Routini runs jobs, fleet commands and incident runbooks for the org "${auth.org.name}". ` +
        'Commands and job runs follow the org policy: some need a person to approve them in Routini before they run, and you cannot approve. ' +
        'When a tool says a run is waiting, tell the user and check back with get_run.',
    },
  )
  const { db } = ctx
  const orgId = auth.org.id
  const trigger = (toolName: string) => ({ kind: 'mcp' as const, userId: auth.user.id, tokenId: auth.token.id, tokenName: auth.token.name, tool: toolName })

  server.registerTool('whoami', { description: 'Who this connection acts as: user, org and role.', inputSchema: {} }, tool(auth, 'viewer', async () => {
    return `${auth.user.email} in org "${auth.org.name}" (${auth.org.slug}) as ${auth.role}, via token "${auth.token.name}".`
  }))

  server.registerTool('list_jobs', { description: 'Jobs in the org, with their triggers and step counts.', inputSchema: {} }, tool(auth, 'viewer', async () => {
    const jobs = await db.org(orgId, (q) => listJobs(q, orgId))
    if (!jobs.length) return 'No jobs yet.'
    return jobs.map((j) => `- ${j.name} (id ${j.id}) · trigger ${j.trigger.kind}${j.enabled ? '' : ' · disabled'} · ${j.steps.length} step${j.steps.length === 1 ? '' : 's'}`).join('\n')
  }))

  server.registerTool(
    'list_runs',
    {
      description: 'Recent runs, newest first. Filter by status (queued, running, waiting, succeeded, failed, canceled).',
      inputSchema: { status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled']).optional(), limit: z.number().int().min(1).max(50).optional() },
    },
    tool(auth, 'viewer', async ({ status, limit }: { status?: RunStatus; limit?: number }) => {
      const runs = await db.org(orgId, (q) => listRuns(q, orgId, { status: status ? [status] : undefined, limit: limit ?? 15 }))
      if (!runs.length) return 'No runs match.'
      return runs.map((r) => `- #${r.number} ${r.jobSnapshot.name} · ${r.status} · ${r.trigger.kind} · ${ago(r.createdAt)}${r.error ? ` · ${r.error}` : ''}`).join('\n')
    }),
  )

  server.registerTool(
    'get_run',
    { description: "A run's steps, results, outputs (command stdout), pending approvals and its last log lines.", inputSchema: { number: z.number().int().min(1) } },
    tool(auth, 'viewer', async ({ number }: { number: number }) => {
      const run = await db.org(orgId, (q) => getRunByNumber(q, orgId, number))
      if (!run) throw new ToolError(`There is no run #${number}.`)
      return describeRun(ctx, orgId, run)
    }),
  )

  server.registerTool('list_hosts', { description: 'Fleet servers: transport (runner or ssh), status, disk and memory.', inputSchema: {} }, tool(auth, 'viewer', async () => {
    const hosts = await db.org(orgId, (q) => listHosts(q, orgId))
    return hosts.length ? hosts.map(hostLine).join('\n') : 'No servers in the fleet yet.'
  }))

  server.registerTool(
    'list_incidents',
    { description: 'Incidents opened by alerts. Default: open ones.', inputSchema: { status: z.enum(['open', 'resolved', 'all']).optional() } },
    tool(auth, 'viewer', async ({ status }: { status?: 'open' | 'resolved' | 'all' }) => {
      const s = status ?? 'open'
      const list = await db.org(orgId, (q) => listIncidents(q, orgId, { status: s === 'all' ? undefined : s, limit: 30 }))
      if (!list.length) return s === 'open' ? 'No open incidents.' : 'No incidents.'
      return list.map((i) => `- #${i.number} [${i.severity}] ${i.title} · ${i.status} · opened ${ago(i.openedAt)}${i.hostName ? ` · host ${i.hostName}` : ''}${i.alertCount > 1 ? ` · ${i.alertCount} alerts` : ''}`).join('\n')
    }),
  )

  server.registerTool(
    'get_incident',
    { description: "An incident's alert, labels, timeline and the runs it started.", inputSchema: { number: z.number().int().min(1) } },
    tool(auth, 'viewer', async ({ number }: { number: number }) => {
      const i = await db.org(orgId, (q) => getIncidentByNumber(q, orgId, number))
      if (!i) throw new ToolError(`There is no incident #${number}.`)
      const [events, runs] = await db.org(orgId, async (q) => [await listIncidentEvents(q, orgId, i.id), await listIncidentRuns(q, orgId, i.id)] as const)
      return [
        `Incident #${i.number} [${i.severity}] ${i.title} · ${i.status} · opened ${ago(i.openedAt)}${i.resolvedAt ? ` · resolved ${ago(i.resolvedAt)}` : ''}`,
        `Host: ${i.hostName ?? 'not matched to a fleet host'}`,
        `Labels: ${Object.entries(i.labels).map(([k, v]) => `${k}=${v}`).join(', ')}`,
        ...Object.entries(i.annotations).map(([k, v]) => `${k}: ${v}`),
        'Timeline:',
        ...events.map((e) => `  ${e.ts} ${e.type}${e.userName ? ` by ${e.userName}` : ''}${e.type === 'note' ? `: ${String(e.data['text'])}` : e.type.startsWith('run.') ? ` #${String(e.data['number'])}${e.data['status'] ? ` ${String(e.data['status'])}` : ''}` : ''}`),
        'Runs:',
        ...(runs.length ? runs.map((r) => `  #${r.number} ${r.jobName} · ${r.status}`) : ['  none']),
      ].join('\n')
    }),
  )

  server.registerTool('list_pending_approvals', { description: 'Approvals waiting for a person. (Approving happens in Routini, not here.)', inputSchema: {} }, tool(auth, 'viewer', async () => {
    const list = await db.org(orgId, (q) => listPendingApprovals(q, orgId))
    return list.length ? list.map((a) => `- run #${a.runNumber} ${a.jobName} / ${a.stepName}: ${a.message} (${a.minRole}+)`).join('\n') : 'Nothing is waiting for approval.'
  }))

  server.registerTool(
    'run_job',
    { description: 'Start a job by name or id. Returns the run number; follow it with get_run.', inputSchema: { job: z.string().min(1).max(200) } },
    tool(auth, 'member', async ({ job }: { job: string }) => {
      const run = await db.org(orgId, async (q) => {
        const byId = /^[0-9a-f-]{36}$/i.test(job) ? await getJob(q, orgId, job) : null
        const found = byId && !byId.archivedAt ? byId : (await listJobs(q, orgId)).find((j) => j.name.toLowerCase() === job.trim().toLowerCase())
        if (!found || (await isHiddenJob(q, orgId, found.id))) throw new ToolError(`No job named "${job}". Use list_jobs to see them.`)
        return createRun(q, found, trigger('run_job'))
      })
      return `Started run #${run.number} (${run.jobSnapshot.name}). Check it with get_run {"number": ${run.number}}.`
    }),
  )

  server.registerTool(
    'run_command',
    {
      description:
        'Run a shell command on a fleet server (by name). It becomes a normal Routini run: org policy applies, so it may need a person to approve it first. ' +
        'Waits up to a minute for the result.',
      inputSchema: { host: z.string().min(1).max(63), command: z.string().min(1).max(8000), timeoutSec: z.number().int().min(1).max(3600).optional() },
    },
    tool(auth, 'member', async ({ host, command, timeoutSec }: { host: string; command: string; timeoutSec?: number }) => {
      const { run, decision } = await db.org(orgId, async (q) => {
        const hosts = await listHosts(q, orgId)
        const h = hosts.find((x) => x.name.toLowerCase() === host.toLowerCase()) ?? hosts.find((x) => x.id === host)
        if (!h) throw new ToolError(`No server named "${host}". Use list_hosts to see the fleet.`)
        const step: Step = { id: 'command', name: `Command on ${h.name}`, kind: 'action', when: 'on_success', retries: 0, timeoutSec: timeoutSec ?? 300, config: { type: 'ssh', hostId: h.id, command } }
        const policy = await getPolicy(q, orgId, ctx.config.mode)
        const decision = evaluatePolicy(policy.rules, await stepFacts(q, orgId, step))
        const adhoc = await ensureAdhocJob(q, orgId)
        const run = await createRun(q, { ...adhoc, name: `Command on ${h.name}`, steps: [step] }, trigger('run_command'))
        return { run, decision }
      })
      const final = await waitForRun(ctx, orgId, run.id, run.number, opts.commandWaitMs ?? 60_000)
      if (final.status === 'waiting') {
        return `Run #${final.number} is waiting for approval${decision.rule ? ` (policy "${decision.rule.name}", ${decision.rule.minRole ?? 'member'}+)` : ''}. A person approves it in Routini; check back with get_run {"number": ${final.number}}.`
      }
      if (!TERMINAL_RUN.includes(final.status)) return `Run #${final.number} is still ${final.status}. Check back with get_run {"number": ${final.number}}.`
      return describeRun(ctx, orgId, final, 10)
    }),
  )

  server.registerTool(
    'cancel_run',
    { description: 'Cancel a queued, running or waiting run.', inputSchema: { number: z.number().int().min(1) } },
    tool(auth, 'member', async ({ number }: { number: number }) => {
      const run = await db.org(orgId, (q) => getRunByNumber(q, orgId, number))
      if (!run) throw new ToolError(`There is no run #${number}.`)
      const after = await cancelRun(ctx, orgId, run)
      return `Run #${number} ${after.status === 'canceled' ? 'is canceled' : 'will stop shortly'}.`
    }),
  )

  server.registerTool(
    'add_incident_note',
    { description: "Add a note to an incident's timeline (it appears in the postmortem).", inputSchema: { number: z.number().int().min(1), text: z.string().min(1).max(10_000) } },
    tool(auth, 'member', async ({ number, text: note }: { number: number; text: string }) => {
      const i = await db.org(orgId, (q) => getIncidentByNumber(q, orgId, number))
      if (!i) throw new ToolError(`There is no incident #${number}.`)
      await db.org(orgId, (q) => addIncidentEvent(q, orgId, i.id, 'note', auth.user.id, { text: note.trim(), via: `mcp:${auth.token.name}` }))
      return `Added a note to incident #${number}.`
    }),
  )

  server.registerTool(
    'resolve_incident',
    { description: 'Mark an incident resolved and draft its postmortem.', inputSchema: { number: z.number().int().min(1) } },
    tool(auth, 'member', async ({ number }: { number: number }) => {
      const i = await db.org(orgId, (q) => getIncidentByNumber(q, orgId, number))
      if (!i) throw new ToolError(`There is no incident #${number}.`)
      if (i.status === 'resolved') return `Incident #${number} was already resolved.`
      await db.org(orgId, async (q) => {
        await resolveIncident(q, orgId, i.id, auth.user.id)
        await draftPostmortem(q, orgId, (await getIncidentByNumber(q, orgId, number))!)
      })
      return `Resolved incident #${number}; a postmortem draft is ready in Routini.`
    }),
  )

  return server
}

/** POST /mcp (stateless Streamable HTTP). GET/DELETE are not used without sessions. */
export function mcpRouter(ctx: AppContext, auth: Auth, opts: { commandWaitMs?: number } = {}): Router {
  const r = Router()
  const unauthorized = (res: Response, message: string) => {
    res.setHeader('WWW-Authenticate', 'Bearer realm="routini"')
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null })
  }
  r.post('/', (req: Request, res: Response) => {
    void (async () => {
      const session = await auth.authenticate(req.headers)
      if (!session?.apiToken) return unauthorized(res, 'Use an API token: Authorization: Bearer rtk_… (Settings → API tokens)')
      const token = session.apiToken
      const org = await getOrgById(ctx.db, token.orgId)
      const membership = org ? await getMembershipRole(ctx.db, org.id, session.user.id) : null
      if (!org || !membership) return unauthorized(res, 'This token no longer has access to its org')
      const server = buildMcpServer(ctx, { user: session.user, org, role: minRole(membership, token.role), token }, opts)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    })().catch((err) => {
      console.error('[mcp] request failed:', (err as Error).message)
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    })
  })
  const notAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST')
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST' }, id: null })
  }
  r.get('/', notAllowed)
  r.delete('/', notAllowed)
  return r
}
