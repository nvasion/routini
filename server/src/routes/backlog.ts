// ─────────────────────────────────────────────────────────────────────────────
// Backlog: sources, items, status writes
//
//   GET    /api/orgs/:org/backlog/sources
//   POST   /api/orgs/:org/backlog/sources                                  (admin)
//   PUT    /api/orgs/:org/backlog/sources/:id                              (admin)
//   DELETE /api/orgs/:org/backlog/sources/:id                              (admin)
//   POST   /api/orgs/:org/backlog/sources/:id/test   preview, nothing saved (admin)
//   POST   /api/orgs/:org/backlog/sources/:id/sync   sync now
//   GET    /api/orgs/:org/backlog/items              ?state=&sourceId=&q=&limit=
//   GET    /api/orgs/:org/backlog/items/:id
//   POST   /api/orgs/:org/backlog/items/:id/ready
//   POST   /api/orgs/:org/backlog/items/:id/drop
//   POST   /api/orgs/:org/backlog/items/:id/start    { jobId }
//   POST   /api/orgs/:org/backlog/writes/:id/retry
//
// Contract: docs/work-intake-backlog.md section 8.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, currentUser, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import { SpecError } from '../engine/spec.js'
import { getJob } from '../repos/jobs.js'
import { createRun } from '../repos/runs.js'
import {
  createSource,
  deleteSource,
  getItem,
  getSource,
  leaseItem,
  listItemEvents,
  listItems,
  listSources,
  markDropAfterRun,
  resetWrite,
  setItemState,
  updateSource,
  type ItemState,
  type SourceInput,
} from '../repos/backlog.js'
import { ITEM_STATES, SOURCE_KINDS, type SourceKind } from '../backlog/types.js'
import { isValidBranchName } from '../utils/repoUrl.js'
import { adapterCtx } from '../backlog/context.js'
import { getAdapter } from '../backlog/index.js'
import { parseMapping } from '../backlog/mapping.js'
import { syncSource } from '../backlog/sync.js'
import { runSummary } from './jobs.js'

const UUID_RE = /^[0-9a-f-]{36}$/i

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function parseConfigOr400(kind: SourceKind, raw: unknown): Record<string, unknown> {
  try {
    return getAdapter(kind).parseConfig(raw) as Record<string, unknown>
  } catch (err) {
    if (err instanceof SpecError) throw badRequest(err.message)
    throw err
  }
}

function parseMappingOr400(raw: unknown): SourceInput['mapping'] {
  try {
    return parseMapping(raw)
  } catch (err) {
    if (err instanceof SpecError) throw badRequest(err.message)
    throw err
  }
}

type SourceFields = Omit<SourceInput, 'config' | 'mapping'>

/** Everything of SourceInput except config/mapping (parsed separately: they need `kind`, resolved first). */
function parseSourceFields(raw: unknown, mode: 'create' | 'update'): Partial<SourceFields> {
  if (!isObj(raw)) throw badRequest('Request body must be an object')
  const out: Partial<SourceFields> = {}
  if (mode === 'create' || raw['name'] !== undefined) {
    const name = raw['name']
    if (typeof name !== 'string' || name.length < 1 || name.length > 80) throw badRequest('name must be a string of 1-80 characters')
    out.name = name
  }
  if (mode === 'create' || raw['kind'] !== undefined) {
    const kind = raw['kind']
    if (!(SOURCE_KINDS as readonly unknown[]).includes(kind)) throw badRequest(`kind must be one of: ${SOURCE_KINDS.join(', ')}`)
    out.kind = kind as SourceKind
  }
  if (raw['defaultRepoUrl'] !== undefined) {
    const v = raw['defaultRepoUrl']
    if (v !== null && typeof v !== 'string') throw badRequest('defaultRepoUrl must be a string or null')
    out.defaultRepoUrl = v
  }
  if (raw['defaultBaseBranch'] !== undefined) {
    const v = raw['defaultBaseBranch']
    if (typeof v !== 'string' || !isValidBranchName(v)) throw badRequest('defaultBaseBranch must match ^[A-Za-z0-9._/-]{1,200}$')
    out.defaultBaseBranch = v
  }
  if (raw['factoryProjectId'] !== undefined) {
    const v = raw['factoryProjectId']
    if (v !== null && typeof v !== 'string') throw badRequest('factoryProjectId must be a string or null')
    out.factoryProjectId = v
  }
  if (raw['enabled'] !== undefined) {
    if (typeof raw['enabled'] !== 'boolean') throw badRequest('enabled must be true or false')
    out.enabled = raw['enabled']
  }
  if (raw['syncEveryMin'] !== undefined) {
    const v = raw['syncEveryMin']
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1440) throw badRequest('syncEveryMin must be an integer between 1 and 1440')
    out.syncEveryMin = v
  }
  return out
}

export function backlogRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })
  const db = ctx.db

  // ── Sources ──────────────────────────────────────────────────────────────

  r.get(
    '/backlog/sources',
    // Reads are open to every org member, viewers included, like the rest of the console.
    ah(async (req, res) => {
      const org = currentOrg(req)
      const sources = await db.org(org.id, (q) => listSources(q, org.id))
      res.json({ sources })
    }),
  )

  r.post(
    '/backlog/sources',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const body = req.body as Record<string, unknown>
      const fields = parseSourceFields(body, 'create')
      const kind = fields.kind!
      const config = parseConfigOr400(kind, isObj(body) ? body['config'] : undefined)
      const mapping = parseMappingOr400(isObj(body) ? body['mapping'] : undefined)
      const input: SourceInput = { ...fields, name: fields.name!, kind, config, mapping }
      const source = await db.org(org.id, (q) => createSource(q, org.id, input))
      res.status(201).json({ source })
    }),
  )

  r.put(
    '/backlog/sources/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const body = req.body as Record<string, unknown>
      const source = await db.org(org.id, async (q) => {
        const current = await getSource(q, org.id, String(req.params['id']))
        if (!current) throw notFound('Backlog source not found')
        const fields = parseSourceFields(body, 'update')
        const kind = fields.kind ?? current.kind
        const input: Partial<SourceInput> = { ...fields }
        if (isObj(body) && body['config'] !== undefined) input.config = parseConfigOr400(kind, body['config'])
        if (isObj(body) && body['mapping'] !== undefined) input.mapping = parseMappingOr400(body['mapping'])
        return updateSource(q, org.id, current.id, input)
      })
      res.json({ source })
    }),
  )

  r.delete(
    '/backlog/sources/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const deleted = await db.org(org.id, (q) => deleteSource(q, org.id, String(req.params['id'])))
      if (!deleted) throw notFound('Backlog source not found')
      res.status(204).end()
    }),
  )

  r.post(
    '/backlog/sources/:id/test',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const source = await db.org(org.id, (q) => getSource(q, org.id, String(req.params['id'])))
      if (!source) throw notFound('Backlog source not found')
      const items = await getAdapter(source.kind).fetch(adapterCtx(ctx, org.id), source.config)
      res.json({ items: items.slice(0, 20), total: items.length })
    }),
  )

  r.post(
    '/backlog/sources/:id/sync',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const source = await db.org(org.id, (q) => getSource(q, org.id, String(req.params['id'])))
      if (!source) throw notFound('Backlog source not found')
      await syncSource(ctx, source)
      const updated = await db.org(org.id, (q) => getSource(q, org.id, source.id))
      res.json({ source: updated })
    }),
  )

  // ── Items ────────────────────────────────────────────────────────────────

  r.get(
    '/backlog/items',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const stateRaw = req.query['state']
      const state = typeof stateRaw === 'string' ? (stateRaw as ItemState) : undefined
      if (state && !(ITEM_STATES as readonly string[]).includes(state)) throw badRequest(`state must be among: ${ITEM_STATES.join(', ')}`)
      const sourceIdRaw = req.query['sourceId']
      const sourceId = typeof sourceIdRaw === 'string' && sourceIdRaw !== '' ? sourceIdRaw : undefined
      if (sourceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)) throw badRequest('sourceId must be a source id')
      const qRaw = req.query['q']
      const search = typeof qRaw === 'string' && qRaw !== '' ? qRaw.slice(0, 200) : undefined
      const limitRaw = req.query['limit']
      const limitNum = typeof limitRaw === 'string' ? Number(limitRaw) : undefined
      if (limitNum !== undefined && (!Number.isInteger(limitNum) || limitNum < 1)) throw badRequest('limit must be a positive integer')
      const limit = limitNum
      const items = await db.org(org.id, (q) => listItems(q, org.id, { state, sourceId, q: search, limit }))
      res.json({ items })
    }),
  )

  r.get(
    '/backlog/items/:id',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const out = await db.org(org.id, async (q) => {
        const item = await getItem(q, org.id, String(req.params['id']))
        if (!item) throw notFound('Backlog item not found')
        const source = await getSource(q, org.id, item.sourceId)
        const events = await listItemEvents(q, org.id, item.id)
        return { item, source, events }
      })
      res.json(out)
    }),
  )

  r.post(
    '/backlog/items/:id/ready',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const item = await db.org(org.id, async (q) => {
        const current = await getItem(q, org.id, String(req.params['id']))
        if (!current) throw notFound('Backlog item not found')
        if (current.runId || (current.state !== 'blocked' && current.state !== 'dropped')) {
          throw new HttpError(409, 'Only a blocked or dropped item can be set ready')
        }
        return setItemState(q, org.id, current.id, 'ready', { event: 'ready.manual' })
      })
      res.json({ item })
    }),
  )

  r.post(
    '/backlog/items/:id/drop',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const item = await db.org(org.id, async (q) => {
        const current = await getItem(q, org.id, String(req.params['id']))
        if (!current) throw notFound('Backlog item not found')
        if (current.runId) {
          await markDropAfterRun(q, org.id, current.id)
          return getItem(q, org.id, current.id)
        }
        return setItemState(q, org.id, current.id, 'dropped', { event: 'dropped.manual' })
      })
      res.json({ item })
    }),
  )

  r.post(
    '/backlog/items/:id/start',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const user = currentUser(req)
      const jobId = (req.body as Record<string, unknown> | undefined)?.['jobId']
      if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) throw badRequest('jobId must be a job id')
      const run = await db.org(org.id, async (q) => {
        const item = await getItem(q, org.id, String(req.params['id']))
        if (!item) throw notFound('Backlog item not found')
        const job = await getJob(q, org.id, jobId)
        const backlog = job && !job.archivedAt && job.trigger.kind === 'cron' ? job.trigger.backlog : undefined
        if (!job || !backlog) throw badRequest("That job doesn't take backlog items")
        if (item.runId || (item.state !== 'ready' && item.state !== 'blocked')) {
          throw new HttpError(409, 'This item is already running or not ready to start')
        }
        const run = await createRun(q, job, { kind: 'backlog', itemId: item.id, sourceId: item.sourceId, userId: user.id })
        await leaseItem(q, org.id, item.id, run.id)
        return run
      })
      res.status(201).json({ run: runSummary(run) })
    }),
  )

  // ── Status writes ────────────────────────────────────────────────────────

  r.post(
    '/backlog/writes/:id/retry',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const ok = await db.org(org.id, (q) => resetWrite(q, org.id, String(req.params['id'])))
      if (!ok) throw notFound('Backlog write not found')
      res.json({ ok: true })
    }),
  )

  return r
}
