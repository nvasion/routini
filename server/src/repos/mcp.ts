// ─────────────────────────────────────────────────────────────────────────────
// Remote MCP servers (tenant table). Header values are secrets in the
// credential store under "mcp.<id>.<header>"; only header names live here.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { SecretBox } from '../crypto/secrets.js'
import { AGENT_IDS, type AgentId } from '../integrations/catalog.js'
import { PLACEHOLDER, type CredentialBinding } from '../egress/types.js'
import { deleteSecretsWithPrefix, getSecret, putSecret } from './credentials.js'

export interface McpServer {
  id: string
  name: string
  url: string
  headerNames: string[]
  agents: AgentId[]
  lastTest: { ok: boolean; at: string; message: string } | null
  createdAt: string
}

interface Row {
  id: string
  name: string
  url: string
  header_names: string[]
  agents: AgentId[]
  last_test: McpServer['lastTest']
  created_at: Date
}
const COLS = 'id, name, url, header_names, agents, last_test, created_at'
const toServer = (r: Row): McpServer => ({ id: r.id, name: r.name, url: r.url, headerNames: r.header_names, agents: r.agents, lastTest: r.last_test, createdAt: new Date(r.created_at).toISOString() })
const headerKey = (id: string, header: string) => `mcp.${id}.${header.toLowerCase()}`

export class McpInputError extends Error {}

export function parseMcpInput(raw: unknown, mode: 'selfhost' | 'hosted', partial = false): { name?: string; url?: string; headers?: Record<string, string>; agents?: AgentId[] } {
  const fail = (m: string): never => {
    throw new McpInputError(m)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Body must be an object')
  const b = raw as Record<string, unknown>
  const out: ReturnType<typeof parseMcpInput> = {}
  if (b['name'] !== undefined || !partial) {
    if (typeof b['name'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(b['name'])) fail('name must be 1–40 chars of a-z, 0-9, "_" or "-"')
    out.name = b['name'] as string
  }
  if (b['url'] !== undefined || !partial) {
    let u: URL
    try {
      u = new URL(String(b['url']))
    } catch {
      return fail('url must be a valid URL')
    }
    if (u.protocol !== 'https:' && !(mode === 'selfhost' && u.protocol === 'http:')) fail('url must use https')
    if (u.username || u.password) fail('url must not contain credentials')
    out.url = u.toString()
  }
  if (b['headers'] !== undefined) {
    const h = b['headers']
    if (!h || typeof h !== 'object' || Array.isArray(h)) fail('headers must be an object of strings')
    out.headers = {}
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== 'string' || !v || v.length > 4096) fail('headers must map header names to non-empty strings')
      out.headers[k.toLowerCase()] = v as string
    }
  }
  if (b['agents'] !== undefined) {
    if (!Array.isArray(b['agents']) || !(b['agents'] as unknown[]).every((a) => (AGENT_IDS as readonly unknown[]).includes(a))) fail(`agents must be among: ${AGENT_IDS.join(', ')}`)
    out.agents = [...new Set(b['agents'] as AgentId[])]
  }
  return out
}

export async function listMcpServers(q: Queryable, orgId: string): Promise<McpServer[]> {
  return (await q.query<Row>(`SELECT ${COLS} FROM mcp_servers WHERE org_id = $1 ORDER BY name`, [orgId])).map(toServer)
}

export async function getMcpServer(q: Queryable, orgId: string, id: string): Promise<McpServer | null> {
  const [row] = await q.query<Row>(`SELECT ${COLS} FROM mcp_servers WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toServer(row) : null
}

export async function createMcpServer(
  q: Queryable,
  box: SecretBox,
  orgId: string,
  userId: string,
  input: { name: string; url: string; headers?: Record<string, string>; agents?: AgentId[] },
): Promise<McpServer> {
  const headers = input.headers ?? {}
  const [row] = await q.query<Row>(
    `INSERT INTO mcp_servers (org_id, name, url, header_names, agents) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [orgId, input.name, input.url, Object.keys(headers), input.agents ?? [...AGENT_IDS]],
  )
  for (const [k, v] of Object.entries(headers)) await putSecret(q, box, orgId, headerKey(row!.id, k), v, userId)
  return toServer(row!)
}

/** Updates fields; `headers`, when given, replaces all stored headers. */
export async function updateMcpServer(
  q: Queryable,
  box: SecretBox,
  orgId: string,
  userId: string,
  id: string,
  input: { name?: string; url?: string; headers?: Record<string, string>; agents?: AgentId[] },
): Promise<McpServer | null> {
  if (input.headers) {
    await deleteSecretsWithPrefix(q, orgId, `mcp.${id}.`)
    for (const [k, v] of Object.entries(input.headers)) await putSecret(q, box, orgId, headerKey(id, k), v, userId)
  }
  const [row] = await q.query<Row>(
    `UPDATE mcp_servers SET name = coalesce($3, name), url = coalesce($4, url), header_names = coalesce($5, header_names),
       agents = coalesce($6, agents), updated_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING ${COLS}`,
    [orgId, id, input.name ?? null, input.url ?? null, input.headers ? Object.keys(input.headers) : null, input.agents ?? null],
  )
  return row ? toServer(row) : null
}

export async function deleteMcpServer(q: Queryable, orgId: string, id: string): Promise<boolean> {
  await deleteSecretsWithPrefix(q, orgId, `mcp.${id}.`)
  return (await q.query('DELETE FROM mcp_servers WHERE org_id = $1 AND id = $2 RETURNING id', [orgId, id])).length > 0
}

export async function recordMcpTest(q: Queryable, orgId: string, id: string, test: NonNullable<McpServer['lastTest']>): Promise<void> {
  await q.query('UPDATE mcp_servers SET last_test = $3 WHERE org_id = $1 AND id = $2', [orgId, id, JSON.stringify(test)])
}

export async function mcpHeaders(q: Queryable, box: SecretBox, orgId: string, s: McpServer): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const h of s.headerNames) {
    const v = await getSecret(q, box, orgId, headerKey(s.id, h))
    if (v !== null) out[h] = v
  }
  return out
}

export interface McpAccess {
  /** Claude Code --mcp-config document (null when the agent has no servers). */
  config: { mcpServers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> } | null
  bindings: CredentialBinding[]
  hosts: string[]
  secrets: string[]
}

/**
 * MCP servers an agent may use. With the broker, header values never go into
 * the config: the proxy sets them on requests to the server's host.
 */
export interface ExtraMcpServer {
  name: string
  url: string
  headers: Record<string, string>
  /** Give the container the real headers even under the broker (plain-http URLs the proxy cannot inject into). */
  direct?: boolean
}

/** The agent's MCP servers: the org's (scoped to this agent) plus `extra` ones (Routini's own tools). */
export async function mcpAccessFor(q: Queryable, box: SecretBox, orgId: string, agent: AgentId, brokered: boolean, extra: ExtraMcpServer[] = []): Promise<McpAccess> {
  const servers = (await listMcpServers(q, orgId)).filter((s) => s.agents.includes(agent))
  const out: McpAccess = { config: null, bindings: [], hosts: [], secrets: [] }
  if (servers.length === 0 && extra.length === 0) return out
  out.config = { mcpServers: {} }
  const all: ExtraMcpServer[] = [...(await Promise.all(servers.map(async (s) => ({ name: s.name, url: s.url, headers: await mcpHeaders(q, box, orgId, s) })))), ...extra]
  for (const s of all) {
    const headers = s.headers
    const host = new URL(s.url).hostname
    out.hosts.push(host)
    out.secrets.push(...Object.values(headers))
    if (brokered && !s.direct) {
      for (const [h, v] of Object.entries(headers)) out.bindings.push({ host, header: h, format: 'raw', secret: v })
      const placeholders = Object.fromEntries(Object.keys(headers).map((h) => [h, PLACEHOLDER]))
      out.config.mcpServers[s.name] = { type: 'http', url: s.url, ...(Object.keys(placeholders).length ? { headers: placeholders } : {}) }
    } else {
      out.config.mcpServers[s.name] = { type: 'http', url: s.url, ...(Object.keys(headers).length ? { headers } : {}) }
    }
  }
  return out
}
