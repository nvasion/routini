// ─────────────────────────────────────────────────────────────────────────────
// Org resolution and role checks for /api/orgs/:org/* routes.
//
// Non-members get 404 (not 403) so org slugs cannot be probed.
// ─────────────────────────────────────────────────────────────────────────────

import type { NextFunction, Request, Response } from 'express'
import { ah, currentOrg, currentUser, forbidden, notFound, type AppContext } from './common.js'
import { getMembershipRole, getOrgBySlug, roleAtLeast, type Role } from '../repos/identity.js'

export function loadOrg(ctx: AppContext) {
  return ah(async (req: Request, _res: Response, next: NextFunction) => {
    const user = currentUser(req)
    const slug = String(req.params['org'] ?? '')
    const org = await getOrgBySlug(ctx.db, slug)
    const role = org ? await getMembershipRole(ctx.db, org.id, user.id) : null
    if (!org || !role) throw notFound('Org not found')
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
