// ─────────────────────────────────────────────────────────────────────────────
// Orgs and members
//
//   GET    /api/orgs                       my orgs
//   POST   /api/orgs                       create an org (caller becomes owner)
//   GET    /api/orgs/:org                  org details + my role + limits
//   PUT    /api/orgs/:org                  rename / tighten limits      (admin)
//   GET    /api/orgs/:org/members          list members
//   POST   /api/orgs/:org/members          add an existing user by email (admin)
//   PUT    /api/orgs/:org/members/:userId  change role                  (admin; owner role: owner only)
//   DELETE /api/orgs/:org/members/:userId  remove                       (admin; never the last owner)
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, forbidden, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { publicMemberships } from '../http/auth.js'
import {
  addMembership,
  countOwners,
  createOrg,
  findUserByEmail,
  getMembershipRole,
  isValidSlug,
  listMembers,
  listOrgsForUser,
  removeMembership,
  ROLES,
  roleAtLeast,
  updateOrg,
  type OrgLimits,
  type Role,
} from '../repos/identity.js'

/** Routes on the org collection, mounted at /api/orgs (before the :org loader). */
export function orgCollectionRouter(ctx: AppContext): Router {
  const r = Router()

  r.get(
    '/',
    ah(async (req, res) => {
      res.json({ orgs: publicMemberships(await listOrgsForUser(ctx.db, currentUser(req).id)) })
    }),
  )

  r.post(
    '/',
    ah(async (req, res) => {
      const user = currentUser(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const name = typeof b['name'] === 'string' ? b['name'].trim() : ''
      if (!name || name.length > 100) throw badRequest('name must be 1–100 characters')
      let slugBase = name
      if (b['slug'] !== undefined) {
        if (typeof b['slug'] !== 'string' || !isValidSlug(b['slug'])) {
          throw badRequest('slug must be 1–40 chars of a-z, 0-9 and "-", not starting or ending with "-"')
        }
        slugBase = b['slug']
      }
      const org = await ctx.db.tx(async (q) => {
        const o = await createOrg(q, { name, slugBase, plan: ctx.config.mode === 'hosted' ? 'free' : 'selfhost' })
        await addMembership(q, o.id, user.id, 'owner')
        return o
      })
      if (b['slug'] !== undefined && org.slug !== b['slug']) {
        // Requested slug was taken; the org exists under a suffixed slug. Report it explicitly.
        res.status(201).json({ org: { ...org, role: 'owner' }, note: `Slug "${String(b['slug'])}" was taken; using "${org.slug}"` })
        return
      }
      res.status(201).json({ org: { ...org, role: 'owner' } })
    }),
  )

  return r
}

/** Routes on one org, mounted at /api/orgs/:org (after the :org loader). */
export function orgRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })

  r.get('/', (req, res) => {
    res.json({ org: currentOrg(req) })
  })

  r.put(
    '/',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const patch: { name?: string; limits?: Partial<OrgLimits> } = {}
      if (b['name'] !== undefined) {
        if (typeof b['name'] !== 'string' || !b['name'].trim() || b['name'].length > 100) throw badRequest('name must be 1–100 characters')
        patch.name = b['name']
      }
      if (b['limits'] !== undefined) {
        const l = b['limits'] as Record<string, unknown>
        if (!l || typeof l !== 'object' || Array.isArray(l)) throw badRequest('limits must be an object')
        const out: Partial<OrgLimits> = {}
        const posInt = (k: keyof OrgLimits, allowNull: boolean) => {
          const v = l[k]
          if (v === undefined) return
          if (v === null && allowNull) {
            ;(out as Record<string, unknown>)[k] = null
            return
          }
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw badRequest(`limits.${k} must be a non-negative number${allowNull ? ' or null' : ''}`)
          ;(out as Record<string, unknown>)[k] = v
        }
        posInt('maxConcurrentRuns', false)
        posInt('maxRunningEnvironments', false)
        posInt('agentMinutesPerDay', true)
        posInt('dailyBudgetUsd', true)
        // Stored overrides can only tighten plan limits (see effectiveLimits).
        patch.limits = out
      }
      const updated = await updateOrg(ctx.db, org.id, patch)
      if (!updated) throw notFound('Org not found')
      res.json({ org: { ...updated, role: org.role } })
    }),
  )

  r.get(
    '/members',
    ah(async (req, res) => {
      res.json({ members: await listMembers(ctx.db, currentOrg(req).id) })
    }),
  )

  const parseRole = (v: unknown): Role => {
    if (!ROLES.includes(v as Role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}`)
    return v as Role
  }
  const assertCanGrant = (actor: Role, role: Role) => {
    if (role === 'owner' && actor !== 'owner') throw forbidden('Only owners can grant the owner role')
  }

  r.post(
    '/members',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const role = parseRole(b['role'] ?? 'member')
      assertCanGrant(org.role, role)
      const email = typeof b['email'] === 'string' ? b['email'] : ''
      const user = email ? await findUserByEmail(ctx.db, email) : null
      // Invitations for people without an account arrive with email delivery; until then they must sign up first.
      if (!user) throw notFound('No user with that email; they need to sign up first')
      if (await getMembershipRole(ctx.db, org.id, user.id)) throw new HttpError(409, 'Already a member')
      await addMembership(ctx.db, org.id, user.id, role)
      res.status(201).json({ members: await listMembers(ctx.db, org.id) })
    }),
  )

  r.put(
    '/members/:userId',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const role = parseRole((req.body ?? {})['role'])
      const userId = String(req.params['userId'])
      await ctx.db.tx(async (q) => {
        const existing = await getMembershipRole(q, org.id, userId)
        if (!existing) throw notFound('Not a member')
        if ((existing === 'owner' || role === 'owner') && !roleAtLeast(org.role, 'owner')) {
          throw forbidden('Only owners can change owner memberships')
        }
        if (existing === 'owner' && role !== 'owner' && (await countOwners(q, org.id)) <= 1) {
          throw badRequest('An org must keep at least one owner')
        }
        await addMembership(q, org.id, userId, role)
      })
      res.json({ members: await listMembers(ctx.db, org.id) })
    }),
  )

  r.delete(
    '/members/:userId',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const userId = String(req.params['userId'])
      await ctx.db.tx(async (q) => {
        const existing = await getMembershipRole(q, org.id, userId)
        if (!existing) throw notFound('Not a member')
        if (existing === 'owner') {
          if (org.role !== 'owner') throw forbidden('Only owners can remove an owner')
          if ((await countOwners(q, org.id)) <= 1) throw badRequest('An org must keep at least one owner')
        }
        await removeMembership(q, org.id, userId)
      })
      res.status(204).end()
    }),
  )

  return r
}
