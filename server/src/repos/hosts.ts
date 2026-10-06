// ─────────────────────────────────────────────────────────────────────────────
// Hosts: the org's server inventory (tenant table). Command steps, terminals
// and the dock's Servers panel use it. A host is reached over SSH (the secret
// lives in the credential store under `credential_key`) or through
// routini-runner (`runner_id`; the runner dials out to Routini).
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'

export interface HostCheck {
  ok: boolean
  at: string
  kernel?: string
  uptime?: string
  diskUsedPct?: number
  memUsedPct?: number
  error?: string
}

/** A runner host's runner, as listed with the host. */
export interface HostRunner {
  id: string
  name: string
  version: string | null
  hostname: string | null
  online: boolean
  connectedAt: string | null
  lastSeenAt: string | null
  capabilities: string[]
  facts: Record<string, unknown> | null
  revoked: boolean
}

export interface Host {
  id: string
  name: string
  group: string
  address: string
  port: number
  /** Login for SSH hosts; null for runner hosts. */
  username: string | null
  auth: 'key' | 'password'
  credentialKey: string | null
  tags: string[]
  lastCheck: HostCheck | null
  /** How Routini reaches the host. */
  transport: 'ssh' | 'runner'
  runner: HostRunner | null
  createdAt: string
  updatedAt: string
}

export interface HostInput {
  name: string
  group: string
  address: string
  port: number
  username: string
  auth: 'key' | 'password'
  credentialKey: string | null
  tags: string[]
}

interface Row {
  id: string
  name: string
  host_group: string
  address: string
  port: number
  username: string | null
  auth: 'key' | 'password'
  credential_key: string | null
  tags: string[]
  last_check: HostCheck | null
  created_at: Date
  updated_at: Date
  transport: 'ssh' | 'runner'
  r_id: string | null
  r_name: string | null
  r_version: string | null
  r_hostname: string | null
  r_connected_at: Date | null
  r_last_seen_at: Date | null
  r_disconnected_at: Date | null
  r_capabilities: string[] | null
  r_facts: Record<string, unknown> | null
  r_revoked_at: Date | null
}

const COLS =
  'h.id, h.name, h.host_group, h.address, h.port, h.username, h.auth, h.credential_key, h.tags, h.last_check, h.created_at, h.updated_at, h.transport, ' +
  'r.id AS r_id, r.name AS r_name, r.version AS r_version, r.hostname AS r_hostname, r.connected_at AS r_connected_at, ' +
  'r.last_seen_at AS r_last_seen_at, r.disconnected_at AS r_disconnected_at, r.capabilities AS r_capabilities, r.facts AS r_facts, r.revoked_at AS r_revoked_at'
const FROM = 'hosts h LEFT JOIN runners r ON r.id = h.runner_id'
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)

/** A runner is online when its latest connect is newer than its latest disconnect. */
export function runnerOnline(r: { connectedAt: Date | string | null; disconnectedAt: Date | string | null; revokedAt: Date | string | null }): boolean {
  if (!r.connectedAt || r.revokedAt) return false
  return !r.disconnectedAt || new Date(r.disconnectedAt) < new Date(r.connectedAt)
}

const toHost = (r: Row): Host => ({
  id: r.id,
  name: r.name,
  group: r.host_group,
  address: r.address,
  port: r.port,
  username: r.username,
  auth: r.auth,
  credentialKey: r.credential_key,
  tags: r.tags,
  lastCheck: r.last_check,
  transport: r.transport,
  runner: r.r_id
    ? {
        id: r.r_id,
        name: r.r_name!,
        version: r.r_version,
        hostname: r.r_hostname,
        online: runnerOnline({ connectedAt: r.r_connected_at, disconnectedAt: r.r_disconnected_at, revokedAt: r.r_revoked_at }),
        connectedAt: iso(r.r_connected_at),
        lastSeenAt: iso(r.r_last_seen_at),
        capabilities: r.r_capabilities ?? [],
        facts: r.r_facts,
        revoked: !!r.r_revoked_at,
      }
    : null,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
})

export class HostInputError extends Error {}

export function parseHostInput(raw: unknown, current?: HostInput): HostInput {
  const fail = (m: string): never => {
    throw new HostInputError(m)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Body must be an object')
  const b = raw as Record<string, unknown>
  const pick = <T>(k: string, fallback: T | undefined, parse: (v: unknown) => T): T => {
    if (b[k] === undefined) return fallback !== undefined ? fallback : fail(`${k} is required`)
    return parse(b[k])
  }
  const s = (k: string, re: RegExp, msg: string) => (v: unknown) => (typeof v === 'string' && re.test(v) ? v : fail(`${k} ${msg}`))
  return {
    name: pick('name', current?.name, s('name', HOST_NAME_RE, 'must be 1–63 chars of letters, digits, ".", "_" or "-"')),
    group: pick('group', current?.group ?? '', s('group', /^[A-Za-z0-9 ._-]{0,60}$/, 'must be at most 60 plain characters')),
    address: pick('address', current?.address, s('address', /^[A-Za-z0-9.:-]{1,253}$/, 'must be a hostname or IP address')),
    port: pick('port', current?.port ?? 22, (v) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535 ? (v as number) : fail('port must be 1–65535'))),
    username: pick('username', current?.username, s('username', /^[A-Za-z0-9._-]{1,64}$/, 'must be a valid login name')),
    auth: pick('auth', current?.auth ?? 'key', (v) => (v === 'key' || v === 'password' ? v : fail('auth must be "key" or "password"'))),
    credentialKey: pick('credentialKey', current?.credentialKey ?? null, (v) =>
      v === null ? null : typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v) ? v : fail('credentialKey must be a credential key or null'),
    ),
    tags: pick('tags', current?.tags ?? [], parseTags(fail)),
  }
}

export const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

export const parseTags =
  (fail: (m: string) => never) =>
  (v: unknown): string[] =>
    Array.isArray(v) && v.length <= 20 && v.every((t) => typeof t === 'string' && /^[A-Za-z0-9._:-]{1,40}$/.test(t))
      ? [...new Set(v as string[])]
      : fail('tags must be up to 20 short tags')

/** Runner hosts: only placement metadata is editable; the runner reports the rest. */
export function parseRunnerHostInput(raw: unknown, current: Host): { name: string; group: string; tags: string[] } {
  const fail = (m: string): never => {
    throw new HostInputError(m)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Body must be an object')
  const b = raw as Record<string, unknown>
  const name = b['name'] === undefined ? current.name : typeof b['name'] === 'string' && HOST_NAME_RE.test(b['name']) ? b['name'] : fail('name must be 1–63 chars of letters, digits, ".", "_" or "-"')
  const group = b['group'] === undefined ? current.group : typeof b['group'] === 'string' && /^[A-Za-z0-9 ._-]{0,60}$/.test(b['group']) ? b['group'] : fail('group must be at most 60 plain characters')
  const tags = b['tags'] === undefined ? current.tags : parseTags(fail)(b['tags'])
  return { name, group, tags }
}

export async function listHosts(q: Queryable, orgId: string): Promise<Host[]> {
  const rows = await q.query<Row>(`SELECT ${COLS} FROM ${FROM} WHERE h.org_id = $1 ORDER BY h.host_group, h.name`, [orgId])
  return rows.map(toHost)
}

export async function getHost(q: Queryable, orgId: string, id: string): Promise<Host | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM ${FROM} WHERE h.org_id = $1 AND h.id = $2`, [orgId, id])
  return row ? toHost(row) : null
}

export async function createHost(q: Queryable, orgId: string, h: HostInput): Promise<Host> {
  const [row] = await q.query<{ id: string }>(
    `INSERT INTO hosts (org_id, name, host_group, address, port, username, auth, credential_key, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [orgId, h.name, h.group, h.address, h.port, h.username, h.auth, h.credentialKey, h.tags],
  )
  return (await getHost(q, orgId, row!.id))!
}

/** A host backed by a runner (created at enrollment). The name gets a numeric suffix if taken. */
export async function createRunnerHost(
  q: Queryable,
  orgId: string,
  h: { name: string; group: string; address: string; tags: string[]; runnerId: string },
): Promise<string> {
  const base = h.name.slice(0, 58)
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`
    const [row] = await q.query<{ id: string }>(
      `INSERT INTO hosts (org_id, name, host_group, address, port, username, transport, runner_id, tags)
       VALUES ($1, $2, $3, $4, 22, NULL, 'runner', $5, $6)
       ON CONFLICT (org_id, name) DO NOTHING RETURNING id`,
      [orgId, name, h.group, h.address.slice(0, 253) || 'unknown', h.runnerId, h.tags],
    )
    if (row) return row.id
  }
  throw new Error('Could not find a free host name')
}

export async function updateHost(q: Queryable, orgId: string, id: string, h: HostInput): Promise<Host | null> {
  const [row] = await q.query<{ id: string }>(
    `UPDATE hosts SET name = $3, host_group = $4, address = $5, port = $6, username = $7, auth = $8, credential_key = $9, tags = $10, updated_at = now()
     WHERE org_id = $1 AND id = $2 AND transport = 'ssh' RETURNING id`,
    [orgId, id, h.name, h.group, h.address, h.port, h.username, h.auth, h.credentialKey, h.tags],
  )
  return row ? getHost(q, orgId, id) : null
}

export async function updateRunnerHost(q: Queryable, orgId: string, id: string, h: { name: string; group: string; tags: string[] }): Promise<Host | null> {
  const [row] = await q.query<{ id: string }>(
    `UPDATE hosts SET name = $3, host_group = $4, tags = $5, updated_at = now() WHERE org_id = $1 AND id = $2 AND transport = 'runner' RETURNING id`,
    [orgId, id, h.name, h.group, h.tags],
  )
  return row ? getHost(q, orgId, id) : null
}

export async function deleteHost(q: Queryable, orgId: string, id: string): Promise<boolean> {
  return (await q.query('DELETE FROM hosts WHERE org_id = $1 AND id = $2 RETURNING id', [orgId, id])).length > 0
}

export async function recordHostCheck(q: Queryable, orgId: string, id: string, check: HostCheck): Promise<void> {
  await q.query('UPDATE hosts SET last_check = $3 WHERE org_id = $1 AND id = $2', [orgId, id, JSON.stringify(check)])
}

// ── Host events (audit) ───────────────────────────────────────────────────────

export interface HostEvent {
  id: number
  ts: string
  type: string
  userId: string | null
  data: Record<string, unknown>
}

export async function addHostEvent(q: Queryable, orgId: string, hostId: string, type: string, userId: string | null, data: Record<string, unknown> = {}): Promise<void> {
  await q.query('INSERT INTO host_events (org_id, host_id, type, user_id, data) VALUES ($1, $2, $3, $4, $5)', [orgId, hostId, type, userId, JSON.stringify(data)])
}

export async function listHostEvents(q: Queryable, orgId: string, hostId: string, limit = 50): Promise<HostEvent[]> {
  const rows = await q.query<{ id: string; ts: Date; type: string; user_id: string | null; data: Record<string, unknown> }>(
    'SELECT id, ts, type, user_id, data FROM host_events WHERE org_id = $1 AND host_id = $2 ORDER BY id DESC LIMIT $3',
    [orgId, hostId, limit],
  )
  return rows.map((r) => ({ id: Number(r.id), ts: new Date(r.ts).toISOString(), type: r.type, userId: r.user_id, data: r.data }))
}

/**
 * Finds the host an alert is about from its instance/host/hostname label
 * ("web-01:9100" → "web-01"), matching name, address or runner hostname.
 */
export async function findHostForLabel(q: Queryable, orgId: string, value: string): Promise<string | null> {
  const v = value.trim().replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/:\d+$/, '')
  if (!v) return null
  const [row] = await q.query<{ id: string }>(
    `SELECT h.id FROM ${FROM}
     WHERE h.org_id = $1 AND (lower(h.name) = lower($2) OR lower(h.address) = lower($2) OR lower(r.hostname) = lower($2)
       OR lower(split_part(r.hostname, '.', 1)) = lower($2) OR lower(split_part($2, '.', 1)) = lower(h.name))
     ORDER BY (lower(h.name) = lower($2)) DESC LIMIT 1`,
    [orgId, v],
  )
  return row?.id ?? null
}

/** Parses the output of the fixed health-check command (see HOST_CHECK_COMMAND). */
export function parseHostCheck(stdout: string): Omit<HostCheck, 'ok' | 'at'> {
  const lines = stdout.split('\n').map((l) => l.trim())
  const out: Omit<HostCheck, 'ok' | 'at'> = {}
  for (const l of lines) {
    if (l.startsWith('KERNEL ')) out.kernel = l.slice(7)
    if (l.startsWith('UPTIME ')) out.uptime = l.slice(7)
    if (l.startsWith('DISK ')) {
      const n = parseInt(l.slice(5), 10)
      if (Number.isFinite(n)) out.diskUsedPct = n
    }
    if (l.startsWith('MEM ')) {
      const [used, total] = l.slice(4).split(/\s+/).map(Number)
      if (used !== undefined && total) out.memUsedPct = Math.round((used / total) * 100)
    }
  }
  return out
}

/** Read-only, POSIX-portable status probe used by POST /hosts/:id/check. */
export const HOST_CHECK_COMMAND =
  `echo "KERNEL $(uname -sr)"; echo "UPTIME $(uptime -p 2>/dev/null || uptime)"; ` +
  `echo "DISK $(df -P / | awk 'NR==2 {print $5}')"; ` +
  `echo "MEM $(free -m 2>/dev/null | awk '/^Mem:/ {print $3, $2}')"`

/** Runner facts → the same health shape SSH checks record. */
export function checkFromFacts(facts: Record<string, unknown>): HostCheck {
  const num = (k: string) => (typeof facts[k] === 'number' ? (facts[k] as number) : undefined)
  const up = num('uptimeSec')
  const days = up !== undefined ? Math.floor(up / 86400) : undefined
  const hours = up !== undefined ? Math.floor((up % 86400) / 3600) : undefined
  return {
    ok: true,
    at: new Date().toISOString(),
    kernel: typeof facts['kernel'] === 'string' ? (facts['kernel'] as string) : undefined,
    uptime: up !== undefined ? `up ${days ? `${days} day${days === 1 ? '' : 's'}, ` : ''}${hours} hour${hours === 1 ? '' : 's'}` : undefined,
    diskUsedPct: num('diskUsedPct'),
    memUsedPct: num('memUsedPct'),
  }
}
