// ─────────────────────────────────────────────────────────────────────────────
// Integrations (org-scoped)
//
//   GET    /api/orgs/:org/integrations           catalog + this org's connection status
//   PUT    /api/orgs/:org/integrations/:id       { credentials?, scopes? }            (admin)
//   POST   /api/orgs/:org/integrations/:id/test  live provider check, persisted       (admin)
//   DELETE /api/orgs/:org/integrations/:id       disconnect: removes secrets + status (admin)
//
// Credential fields are write-only. On first connect every field is required;
// afterwards omitted fields keep their stored value. The live check reads only
// what is stored — it never accepts credentials in the request.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { DEFAULT_SCOPES, getIntegrationDef, INTEGRATIONS, parseScopes, type IntegrationDef, type IntegrationScopes } from '../integrations/catalog.js'
import { runProviderTest, type ProviderTestContext } from '../integrations/providers.js'
import {
  disconnectIntegration,
  getIntegrationCredentials,
  getIntegrationState,
  listIntegrationStates,
  recordIntegrationTest,
  saveIntegration,
  type IntegrationState,
} from '../repos/integrations.js'

const MAX_FIELD_LEN = 4096

function view(def: IntegrationDef, state: IntegrationState | null | undefined) {
  const status = !state?.connectedAt ? 'not_connected' : state.lastTestOk === false ? 'error' : 'connected'
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    setupUrl: def.setupUrl,
    setupLabel: def.setupLabel,
    fields: def.fields.map(({ key, label, secret }) => ({ key, label, secret })),
    status,
    connectedAt: state?.connectedAt ?? null,
    lastTestAt: state?.lastTestAt ?? null,
    lastTestOk: state?.lastTestOk ?? null,
    lastTestMessage: state?.lastTestMessage ?? null,
    scopes: state?.scopes ?? DEFAULT_SCOPES,
    serverOnly: Boolean(def.serverOnly),
    comingSoon: Boolean(def.comingSoon),
  }
}

export function integrationsRouter(ctx: AppContext, providerCtx: ProviderTestContext = {}): Router {
  const r = Router({ mergeParams: true })

  // Used only by the mutating routes below (PUT/POST test/DELETE); GET lists
  // every def, including coming-soon ones, via `view()` directly.
  const connectableDefOr404 = (id: unknown) => {
    const def = getIntegrationDef(String(id))
    if (!def) throw notFound('Unknown integration')
    if (def.comingSoon) throw new HttpError(409, `${def.name} is coming soon`)
    return def
  }

  r.get(
    '/integrations',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const states = await ctx.db.org(org.id, (q) => listIntegrationStates(q, org.id))
      res.json({ integrations: INTEGRATIONS.map((d) => view(d, states.get(d.id))) })
    }),
  )

  r.put(
    '/integrations/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const def = connectableDefOr404(req.params['id'])
      const body = (req.body ?? {}) as Record<string, unknown>

      let credentials: Record<string, string> | undefined
      if (body['credentials'] !== undefined) {
        const raw = body['credentials']
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('credentials must be an object')
        credentials = {}
        const allowed = new Set(def.fields.map((f) => f.key))
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (!allowed.has(k)) throw badRequest(`Unknown field "${k}" for ${def.name}`)
          if (typeof v !== 'string' || !v.trim() || v.length > MAX_FIELD_LEN) {
            throw badRequest(`${k} must be a non-empty string of at most ${MAX_FIELD_LEN} characters`)
          }
          credentials[k] = v.trim()
        }
      }
      let scopes: IntegrationScopes | undefined
      if (body['scopes'] !== undefined) {
        try {
          scopes = parseScopes(body['scopes'])
        } catch (err) {
          throw badRequest((err as Error).message)
        }
      }
      if (!credentials && !scopes) throw badRequest('Provide credentials and/or scopes')

      const state = await ctx.db.org(org.id, async (q) => {
        const existing = await getIntegrationState(q, org.id, def.id)
        if (!existing?.connectedAt) {
          const missing = def.fields.filter((f) => !credentials?.[f.key]).map((f) => f.key)
          if (missing.length) throw badRequest(`Missing required field(s) for first connect: ${missing.join(', ')}`)
        }
        return saveIntegration(q, ctx.box, org.id, currentUser(req).id, def.id, { credentials, scopes })
      })
      res.json({ integration: view(def, state) })
    }),
  )

  r.post(
    '/integrations/:id/test',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const def = connectableDefOr404(req.params['id'])
      const creds = await ctx.db.org(org.id, async (q) => {
        const state = await getIntegrationState(q, org.id, def.id)
        if (!state?.connectedAt) throw badRequest(`${def.name} is not connected`)
        return getIntegrationCredentials(q, ctx.box, org.id, def.id)
      })
      // The provider call happens outside the transaction so a slow API never holds a connection.
      let ok = false
      let message: string
      try {
        const result = await runProviderTest(def.id, creds, { allowPrivateHosts: ctx.config.mode === 'selfhost', ...providerCtx })
        ok = result.ok
        message = result.message
      } catch (err) {
        console.error(`[integrations] ${def.id} test failed:`, (err as Error).message)
        message = 'Connection test failed'
      }
      const state = await ctx.db.org(org.id, (q) => recordIntegrationTest(q, org.id, def.id, ok, message))
      res.json({ ok, message, integration: view(def, state) })
    }),
  )

  r.delete(
    '/integrations/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const def = connectableDefOr404(req.params['id'])
      await ctx.db.org(org.id, (q) => disconnectIntegration(q, org.id, def.id))
      res.json({ integration: view(def, null) })
    }),
  )

  return r
}
