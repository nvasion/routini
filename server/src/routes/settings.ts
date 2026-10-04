// ─────────────────────────────────────────────────────────────────────────────
// Org settings and the generic credential store
//
//   GET  /api/orgs/:org/settings              AI endpoints, notifications, which keys exist
//   PUT  /api/orgs/:org/settings              partial update; fully validated first   (admin)
//   GET  /api/orgs/:org/credentials           metadata only (key + timestamps)
//   PUT  /api/orgs/:org/credentials/:key      { value } write-only                     (admin)
//   DELETE /api/orgs/:org/credentials/:key                                             (admin)
//
// Secrets never appear in any response. Keys under integration.* and ai.* are
// owned by the integrations and settings APIs and cannot be written here.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { applySettingsPatch, getOrgSettings, parseSettingsPatch, SettingsValidationError } from '../repos/settings.js'
import {
  deleteSecret,
  listSecrets,
  putSecret,
  RESERVED_PREFIXES,
  validateCredentialKey,
  validateSecretValue,
} from '../repos/credentials.js'

export function settingsRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })

  r.get(
    '/settings',
    ah(async (req, res) => {
      const org = currentOrg(req)
      res.json(await ctx.db.org(org.id, (q) => getOrgSettings(q, org.id)))
    }),
  )

  r.put(
    '/settings',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const user = currentUser(req)
      const settings = await ctx.db.org(org.id, async (q) => {
        const current = await getOrgSettings(q, org.id)
        let patch
        try {
          patch = parseSettingsPatch(req.body, current)
        } catch (err) {
          if (err instanceof SettingsValidationError) throw badRequest(err.message)
          throw err
        }
        await applySettingsPatch(q, ctx.box, org.id, user.id, patch)
        return getOrgSettings(q, org.id)
      })
      res.json(settings)
    }),
  )

  r.get(
    '/credentials',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const all = await ctx.db.org(org.id, (q) => listSecrets(q, org.id))
      res.json({ credentials: all.filter((c) => !RESERVED_PREFIXES.some((p) => c.key.startsWith(p))) })
    }),
  )

  const userKey = (raw: unknown): string => {
    const key = String(raw ?? '')
    try {
      validateCredentialKey(key)
    } catch (err) {
      throw badRequest((err as Error).message)
    }
    if (RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
      throw badRequest(`Keys starting with ${RESERVED_PREFIXES.join(' or ')} are managed by Routini (integrations, settings and webhooks)`)
    }
    return key
  }

  r.put(
    '/credentials/:key',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const key = userKey(req.params['key'])
      const value = (req.body ?? {})['value']
      try {
        validateSecretValue(value)
      } catch (err) {
        throw badRequest((err as Error).message)
      }
      await ctx.db.org(org.id, (q) => putSecret(q, ctx.box, org.id, key, value, currentUser(req).id))
      res.json({ key, stored: true })
    }),
  )

  r.delete(
    '/credentials/:key',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const key = userKey(req.params['key'])
      const removed = await ctx.db.org(org.id, (q) => deleteSecret(q, org.id, key))
      if (!removed) throw notFound('No credential with that key')
      res.status(204).end()
    }),
  )

  return r
}
