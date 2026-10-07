// ─────────────────────────────────────────────────────────────────────────────
// Host pools: an agent step's `runOn: { pool }` names a group/tag match
// instead of one host, so the engine picks the least busy fleet host that
// qualifies at run time. Shared by the save-time check in routes/jobs.ts
// (does any host match at all?) and prepare.ts (which one runs this step?).
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import { listHosts, type Host } from '../repos/hosts.js'

export interface AgentPool {
  group?: string
  tags?: string[]
}

export class PoolError extends Error {}

/** A host's group and tags satisfy the pool, regardless of its transport or runner state. */
export function matchesPool(host: Host, pool: AgentPool): boolean {
  if (pool.group !== undefined && host.group !== pool.group) return false
  if (pool.tags?.length && !pool.tags.every((t) => host.tags.includes(t))) return false
  return true
}

/** How a pool reads in an error message. */
export function describePool(pool: AgentPool): string {
  return `group "${pool.group ?? ''}" and tags ${JSON.stringify(pool.tags ?? [])}`
}

/** `runner.facts.docker.agentsRunning`/`maxAgents`; missing reads as 0 of 2. */
function busyness(host: Host): { running: number; max: number } {
  const facts = host.runner?.facts
  const docker = facts && typeof facts['docker'] === 'object' && facts['docker'] && !Array.isArray(facts['docker']) ? (facts['docker'] as Record<string, unknown>) : null
  const running = typeof docker?.['agentsRunning'] === 'number' ? (docker['agentsRunning'] as number) : 0
  const max = typeof docker?.['maxAgents'] === 'number' ? (docker['maxAgents'] as number) : 2
  return { running, max }
}

/**
 * Resolves an agent step's `runOn: { pool }` to one of the org's own fleet
 * hosts: a runner host, online, not revoked, with the `agents` capability,
 * matching the pool, and with a free agent slot. Among those, picks the
 * least busy (agentsRunning/maxAgents), breaking ties by which runner has
 * gone longest without an agent task (never-used first), then by host name.
 * Throws PoolError, naming the pool, when no host qualifies at some stage.
 */
export async function pickPoolHost(q: Queryable, orgId: string, pool: AgentPool): Promise<{ hostId: string }> {
  const hosts = await listHosts(q, orgId)
  const inPool = hosts.filter((h) => matchesPool(h, pool))
  if (inPool.length === 0) throw new PoolError(`No fleet host matches this step's pool (${describePool(pool)})`)

  const ready = inPool.filter((h) => h.transport === 'runner' && h.runner && !h.runner.revoked && h.runner.online && h.runner.capabilities.includes('agents'))
  if (ready.length === 0) throw new PoolError(`None of the ${inPool.length} hosts in this step's pool is online with agents enabled`)

  const lastUsed = new Map<string, number>()
  const rows = await q.query<{ runner_id: string; last_used: Date }>(
    `SELECT runner_id, max(created_at) AS last_used FROM runner_tasks WHERE org_id = $1 AND payload->>'type' = 'agent' GROUP BY runner_id`,
    [orgId],
  )
  for (const r of rows) lastUsed.set(r.runner_id, new Date(r.last_used).getTime())

  const available = ready.map((h) => ({ host: h, ...busyness(h) })).filter((c) => c.running < c.max)
  if (available.length === 0) throw new PoolError(`All ${ready.length} hosts in this step's pool are busy (every agent slot is in use)`)

  available.sort((a, b) => {
    const loadA = a.running / a.max
    const loadB = b.running / b.max
    if (loadA !== loadB) return loadA - loadB
    const lastA = lastUsed.get(a.host.runner!.id) ?? -Infinity
    const lastB = lastUsed.get(b.host.runner!.id) ?? -Infinity
    if (lastA !== lastB) return lastA - lastB
    return a.host.name.localeCompare(b.host.name)
  })
  return { hostId: available[0]!.host.id }
}
