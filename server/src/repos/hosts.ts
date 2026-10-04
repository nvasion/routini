// ─────────────────────────────────────────────────────────────────────────────
// Hosts: the org's server inventory (tenant table). SSH steps and the dock's
// Servers panel use it. The SSH secret lives in the credential store under
// `credential_key`; this table holds only connection metadata.
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

export interface Host {
  id: string
  name: string
  group: string
  address: string
  port: number
  username: string
  auth: 'key' | 'password'
  credentialKey: string | null
  tags: string[]
  lastCheck: HostCheck | null
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
  username: string
  auth: 'key' | 'password'
  credential_key: string | null
  tags: string[]
  last_check: HostCheck | null
  created_at: Date
  updated_at: Date
}

const COLS = 'id, name, host_group, address, port, username, auth, credential_key, tags, last_check, created_at, updated_at'
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
    name: pick('name', current?.name, s('name', /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'must be 1–63 chars of letters, digits, ".", "_" or "-"')),
    group: pick('group', current?.group ?? '', s('group', /^[A-Za-z0-9 ._-]{0,60}$/, 'must be at most 60 plain characters')),
    address: pick('address', current?.address, s('address', /^[A-Za-z0-9.:-]{1,253}$/, 'must be a hostname or IP address')),
    port: pick('port', current?.port ?? 22, (v) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535 ? (v as number) : fail('port must be 1–65535'))),
    username: pick('username', current?.username, s('username', /^[A-Za-z0-9._-]{1,64}$/, 'must be a valid login name')),
    auth: pick('auth', current?.auth ?? 'key', (v) => (v === 'key' || v === 'password' ? v : fail('auth must be "key" or "password"'))),
    credentialKey: pick('credentialKey', current?.credentialKey ?? null, (v) =>
      v === null ? null : typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v) ? v : fail('credentialKey must be a credential key or null'),
    ),
    tags: pick('tags', current?.tags ?? [], (v) =>
      Array.isArray(v) && v.length <= 20 && v.every((t) => typeof t === 'string' && /^[A-Za-z0-9._:-]{1,40}$/.test(t))
        ? [...new Set(v as string[])]
        : fail('tags must be up to 20 short tags'),
    ),
  }
}

export async function listHosts(q: Queryable, orgId: string): Promise<Host[]> {
  const rows = await q.query<Row>(`SELECT ${COLS} FROM hosts WHERE org_id = $1 ORDER BY host_group, name`, [orgId])
  return rows.map(toHost)
}

export async function getHost(q: Queryable, orgId: string, id: string): Promise<Host | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM hosts WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toHost(row) : null
}

export async function createHost(q: Queryable, orgId: string, h: HostInput): Promise<Host> {
  const [row] = await q.query<Row>(
    `INSERT INTO hosts (org_id, name, host_group, address, port, username, auth, credential_key, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
    [orgId, h.name, h.group, h.address, h.port, h.username, h.auth, h.credentialKey, h.tags],
  )
  return toHost(row!)
}

export async function updateHost(q: Queryable, orgId: string, id: string, h: HostInput): Promise<Host | null> {
  const [row] = await q.query<Row>(
    `UPDATE hosts SET name = $3, host_group = $4, address = $5, port = $6, username = $7, auth = $8, credential_key = $9, tags = $10, updated_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING ${COLS}`,
    [orgId, id, h.name, h.group, h.address, h.port, h.username, h.auth, h.credentialKey, h.tags],
  )
  return row ? toHost(row) : null
}

export async function deleteHost(q: Queryable, orgId: string, id: string): Promise<boolean> {
  return (await q.query('DELETE FROM hosts WHERE org_id = $1 AND id = $2 RETURNING id', [orgId, id])).length > 0
}

export async function recordHostCheck(q: Queryable, orgId: string, id: string, check: HostCheck): Promise<void> {
  await q.query('UPDATE hosts SET last_check = $3 WHERE org_id = $1 AND id = $2', [orgId, id, JSON.stringify(check)])
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
