// ─────────────────────────────────────────────────────────────────────────────
// API tokens (MCP clients, scripts)
//
//   GET    /api/orgs/:org/tokens[?all=1]   yours; admins may list everyone's
//   POST   /api/orgs/:org/tokens           { name, role, expiresInDays? } → token (shown once)
//   DELETE /api/orgs/:org/tokens/:id       yours, or anyone's as an admin
//
// A token's role can't exceed yours, and API tokens can't create tokens.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, HttpError, notFound, type AppContext } from '../http/common.js'
import { roleAtLeast } from '../repos/identity.js'
import { createApiToken, getApiToken, listApiTokens, revokeApiToken, type TokenRole } from '../repos/apiTokens.js'

export function mcpInstallCommand(publicUrl: string, token: string): string {
  return `claude mcp add --transport http routini ${publicUrl}/mcp --header "Authorization: Bearer ${token}"`
}

export function tokensRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })

  r.get(
    '/tokens',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const all = req.query['all'] === '1' && roleAtLeast(org.role, 'admin')
      res.json({ tokens: await ctx.db.org(org.id, (q) => listApiTokens(q, org.id, all ? {} : { userId: currentUser(req).id })) })
    }),
  )

  r.post(
    '/tokens',
    ah(async (req, res) => {
      const org = currentOrg(req)
      if (req.apiToken) throw new HttpError(403, 'API tokens cannot create tokens')
      const b = (req.body ?? {}) as Record<string, unknown>
      const name = typeof b['name'] === 'string' ? b['name'].trim() : ''
      if (!name || name.length > 80) throw badRequest('name must be 1–80 characters')
      const role = (b['role'] ?? 'member') as TokenRole
      if (!['viewer', 'member', 'admin'].includes(role)) throw badRequest('role must be viewer, member or admin')
      if (!roleAtLeast(org.role, role)) throw new HttpError(403, `You cannot create a token with the ${role} role`)
      let expiresAt: Date | null = null
      if (b['expiresInDays'] !== undefined && b['expiresInDays'] !== null) {
        const d = b['expiresInDays']
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 365) throw badRequest('expiresInDays must be 1–365')
        expiresAt = new Date(Date.now() + d * 86_400_000)
      }
      const { token, apiToken } = await ctx.db.org(org.id, (q) => createApiToken(q, org.id, currentUser(req).id, { name, role, expiresAt }))
      res.status(201).json({ token, apiToken, mcpUrl: `${ctx.config.publicUrl}/mcp`, mcpCommand: mcpInstallCommand(ctx.config.publicUrl, token) })
    }),
  )

  r.delete(
    '/tokens/:id',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = String(req.params['id'])
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Token not found')
      await ctx.db.org(org.id, async (q) => {
        const t = await getApiToken(q, org.id, id)
        if (!t || (t.userId !== currentUser(req).id && !roleAtLeast(org.role, 'admin'))) throw notFound('Token not found')
        await revokeApiToken(q, org.id, id)
      })
      res.status(204).end()
    }),
  )

  return r
}
