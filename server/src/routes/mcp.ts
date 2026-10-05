// ─────────────────────────────────────────────────────────────────────────────
// Remote MCP servers (agent tools)
//
//   GET    /api/orgs/:org/mcp-servers
//   POST   /api/orgs/:org/mcp-servers               { name, url, headers?, agents? }   (admin)
//   PUT    /api/orgs/:org/mcp-servers/:id           partial; headers replace all       (admin)
//   DELETE /api/orgs/:org/mcp-servers/:id                                             (admin)
//   POST   /api/orgs/:org/mcp-servers/:id/test      JSON-RPC initialize                (admin)
//
// Header values are write-only, like every other secret.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { createMcpServer, deleteMcpServer, getMcpServer, listMcpServers, mcpHeaders, McpInputError, parseMcpInput, recordMcpTest, updateMcpServer } from '../repos/mcp.js'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'

export type McpFetch = (url: string, init: RequestInit) => Promise<Response>

/** Sends a JSON-RPC initialize and reports the server's name and version. */
export async function testMcpServer(
  url: string,
  headers: Record<string, string>,
  opts: { fetchImpl?: McpFetch; allowPrivateHosts: boolean; timeoutMs?: number },
): Promise<{ ok: boolean; message: string }> {
  const u = new URL(url)
  if (!opts.allowPrivateHosts && (!isSsrfSafeHostname(u.hostname) || !(await resolvedIpIsSsrfSafe(u.hostname).catch(() => false)))) {
    return { ok: false, message: 'The MCP server address is private or could not be resolved' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000)
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'manual',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'routini', version: '1.0' } } }),
    })
    if (!res.ok) return { ok: false, message: `The MCP server returned HTTP ${res.status}` }
    const text = await res.text()
    // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
    const json = text.trim().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? ''
    const body = JSON.parse(json) as { result?: { serverInfo?: { name?: string; version?: string } }; error?: { message?: string } }
    if (body.error) return { ok: false, message: `The MCP server refused initialize: ${body.error.message ?? 'error'}` }
    const info = body.result?.serverInfo
    return { ok: true, message: info?.name ? `Connected to ${info.name}${info.version ? ` ${info.version}` : ''}` : 'Connected' }
  } catch (err) {
    return { ok: false, message: (err as Error).name === 'AbortError' ? 'The MCP server did not answer in time' : 'Could not reach the MCP server' }
  } finally {
    clearTimeout(timer)
  }
}

export function mcpRouter(ctx: AppContext, fetchImpl?: McpFetch): Router {
  const r = Router({ mergeParams: true })
  const parse = (raw: unknown, partial = false) => {
    try {
      return parseMcpInput(raw, ctx.config.mode, partial)
    } catch (err) {
      if (err instanceof McpInputError) throw badRequest(err.message)
      throw err
    }
  }
  const unique = (err: unknown) => (err as { code?: string })?.code === '23505'
  const idOr404 = (raw: unknown) => {
    const id = String(raw)
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('MCP server not found')
    return id
  }

  r.get(
    '/mcp-servers',
    ah(async (req, res) => {
      const org = currentOrg(req)
      res.json({ servers: await ctx.db.org(org.id, (q) => listMcpServers(q, org.id)) })
    }),
  )

  r.post(
    '/mcp-servers',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const input = parse(req.body) as { name: string; url: string }
      try {
        res.status(201).json({ server: await ctx.db.org(org.id, (q) => createMcpServer(q, ctx.box, org.id, currentUser(req).id, input)) })
      } catch (err) {
        if (unique(err)) throw new HttpError(409, `An MCP server named "${input.name}" already exists`)
        throw err
      }
    }),
  )

  r.put(
    '/mcp-servers/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const input = parse(req.body, true)
      try {
        const server = await ctx.db.org(org.id, (q) => updateMcpServer(q, ctx.box, org.id, currentUser(req).id, idOr404(req.params['id']), input))
        if (!server) throw notFound('MCP server not found')
        res.json({ server })
      } catch (err) {
        if (unique(err)) throw new HttpError(409, 'Another MCP server already has that name')
        throw err
      }
    }),
  )

  r.delete(
    '/mcp-servers/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      if (!(await ctx.db.org(org.id, (q) => deleteMcpServer(q, org.id, idOr404(req.params['id']))))) throw notFound('MCP server not found')
      res.status(204).end()
    }),
  )

  r.post(
    '/mcp-servers/:id/test',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      const { server, headers } = await ctx.db.org(org.id, async (q) => {
        const server = await getMcpServer(q, org.id, id)
        if (!server) throw notFound('MCP server not found')
        return { server, headers: await mcpHeaders(q, ctx.box, org.id, server) }
      })
      const result = await testMcpServer(server.url, headers, { fetchImpl, allowPrivateHosts: ctx.config.mode === 'selfhost' })
      const test = { ...result, at: new Date().toISOString() }
      await ctx.db.org(org.id, (q) => recordMcpTest(q, org.id, id, test))
      res.json({ test })
    }),
  )

  return r
}
