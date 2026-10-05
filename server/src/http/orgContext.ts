// ─────────────────────────────────────────────────────────────────────────────
// Org resolution and role checks for /api/orgs/:org/* routes.
//
// Non-members get 404 (not 403) so org slugs cannot be probed.
// ─────────────────────────────────────────────────────────────────────────────

import type { NextFunction, Request, Response } from 'express'
import { ah, currentOrg, currentUser, forbidden, notFound, type AppContext } from './common.js'
import { getMembershipRole, getOrgBySlug, roleAtLeast, type Role } from '../repos/identity.js'
import { minRole } from '../repos/apiTokens.js'

export function loadOrg(ctx: AppContext) {
  return ah(async (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req)
    const slug = String(req.params['org'] ?? '')
    const org = await getOrgBySlug(ctx.db, slug)
    const membership = org ? await getMembershipRole(ctx.db, org.id, user.id) : null
    if (!org || !membership) throw notFound('Org not found')
    // An API token only reaches its own org, with the lower of its role and the owner's.
    const token = req.apiToken
    if (token && token.orgId !== org.id) throw notFound('Org not found')
    const role = token ? minRole(membership, token.role) : membership
    req.org = { ...org, role }
    next()
  })
}

export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const org = currentOrg(req)
    if (!roleAtLeast(org.role, min)) {
      next(forbidden(`This action requires the ${min} role`))
      return
    }
    next()
  }
}
