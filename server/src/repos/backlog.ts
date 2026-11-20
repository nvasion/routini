// ─────────────────────────────────────────────────────────────────────────────
// Backlog sources, items, their event timeline, and queued status writes
// (tenant tables; contract: docs/work-intake-backlog.md §§2-3).
//
// `ItemState` and `StatusMapping` live in backlog/types.ts (shared with the
// source adapters) and are re-exported here, not redefined.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import { ITEM_STATES, type ItemState, type StatusMapping } from '../backlog/types.js'

export type { ItemState, StatusMapping }

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null)

// ── Sources ──────────────────────────────────────────────────────────────────

export interface BacklogSource {
  id: string
  orgId: string
  name: string
  kind: 'monday' | 'repo'
  config: Record<string, unknown>
  mapping: StatusMapping
  defaultRepoUrl: string | null
  defaultBaseBranch: string
  factoryProjectId: string | null
  enabled: boolean
  syncEveryMin: number
  nextSyncAt: string
  lastSyncAt: string | null
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
}

export type SourceInput = {
  name: string
  kind: 'monday' | 'repo'
  config: Record<string, unknown>
  mapping: StatusMapping
  defaultRepoUrl?: string | null
  defaultBaseBranch?: string
  factoryProjectId?: string | null
  enabled?: boolean
  syncEveryMin?: number
}

interface SourceRow {
  id: string
  org_id: string
  name: string
  kind: 'monday' | 'repo'
  config: Record<string, unknown>
  mapping: StatusMapping
  default_repo_url: string | null
  default_base_branch: string
  factory_project_id: string | null
  enabled: boolean
  sync_every_min: number
  next_sync_at: Date
  last_sync_at: Date | null
  last_sync_error: string | null
  created_at: Date
  updated_at: Date
}

const SOURCE_COLS =
  'id, org_id, name, kind, config, mapping, default_repo_url, default_base_branch, factory_project_id, enabled, sync_every_min, next_sync_at, last_sync_at, last_sync_error, created_at, updated_at'
const prefixed = (cols: string, alias: string) => cols.split(', ').map((c) => `${alias}.${c}`).join(', ')

function toSource(r: SourceRow): BacklogSource {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    kind: r.kind,
    config: r.config,
    mapping: r.mapping,
    defaultRepoUrl: r.default_repo_url,
    defaultBaseBranch: r.default_base_branch,
    factoryProjectId: r.factory_project_id,
    enabled: r.enabled,
    syncEveryMin: r.sync_every_min,
    nextSyncAt: iso(r.next_sync_at)!,
    lastSyncAt: iso(r.last_sync_at),
    lastSyncError: r.last_sync_error,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  }
}

export async function listSources(q: Queryable, orgId: string): Promise<BacklogSource[]> {
  const rows = await q.query<SourceRow>(`SELECT ${SOURCE_COLS} FROM backlog_sources WHERE org_id = $1 ORDER BY name`, [orgId])
  return rows.map(toSource)
}

export async function getSource(q: Queryable, orgId: string, id: string): Promise<BacklogSource | null> {
  const [row] = await q.query<SourceRow>(`SELECT ${SOURCE_COLS} FROM backlog_sources WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toSource(row) : null
}

export async function createSource(q: Queryable, orgId: string, input: SourceInput): Promise<BacklogSource> {
  const [row] = await q.query<SourceRow>(
    `INSERT INTO backlog_sources (org_id, name, kind, config, mapping, default_repo_url, default_base_branch, factory_project_id, enabled, sync_every_min)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${SOURCE_COLS}`,
    [
      orgId,
      input.name,
      input.kind,
      JSON.stringify(input.config),
      JSON.stringify(input.mapping),
      input.defaultRepoUrl ?? null,
      input.defaultBaseBranch ?? 'main',
      input.factoryProjectId ?? null,
      input.enabled ?? true,
      input.syncEveryMin ?? 5,
    ],
  )
  return toSource(row!)
}

export async function updateSource(q: Queryable, orgId: string, id: string, input: Partial<SourceInput>): Promise<BacklogSource | null> {
  const [row] = await q.query<SourceRow>(
    `UPDATE backlog_sources SET
       name = coalesce($3, name),
       kind = coalesce($4, kind),
       config = coalesce($5, config),
       mapping = coalesce($6, mapping),
       default_repo_url = CASE WHEN $7::boolean THEN $8 ELSE default_repo_url END,
       default_base_branch = coalesce($9, default_base_branch),
       factory_project_id = CASE WHEN $10::boolean THEN $11 ELSE factory_project_id END,
       enabled = coalesce($12, enabled),
       sync_every_min = coalesce($13, sync_every_min),
       updated_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING ${SOURCE_COLS}`,
    [
      orgId,
      id,
      input.name ?? null,
      input.kind ?? null,
      input.config !== undefined ? JSON.stringify(input.config) : null,
      input.mapping !== undefined ? JSON.stringify(input.mapping) : null,
      input.defaultRepoUrl !== undefined,
      input.defaultRepoUrl ?? null,
      input.defaultBaseBranch ?? null,
      input.factoryProjectId !== undefined,
      input.factoryProjectId ?? null,
      input.enabled ?? null,
      input.syncEveryMin ?? null,
    ],
  )
  return row ? toSource(row) : null
}

export async function deleteSource(q: Queryable, orgId: string, id: string): Promise<boolean> {
  return (await q.query('DELETE FROM backlog_sources WHERE org_id = $1 AND id = $2 RETURNING id', [orgId, id])).length > 0
}

/** System context: due sources are claimed (next_sync_at pushed out) and returned in one statement. */
export async function claimDueSources(q: Queryable, limit: number): Promise<BacklogSource[]> {
  const rows = await q.query<SourceRow>(
    `WITH due AS (
       SELECT id FROM backlog_sources WHERE enabled AND next_sync_at <= now() ORDER BY next_sync_at FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE backlog_sources s SET next_sync_at = now() + make_interval(mins => s.sync_every_min)
     FROM due WHERE s.id = due.id RETURNING ${prefixed(SOURCE_COLS, 's')}`,
    [limit],
  )
  return rows.map(toSource)
}

export async function recordSync(q: Queryable, orgId: string, id: string, error: string | null): Promise<void> {
  await q.query(`UPDATE backlog_sources SET last_sync_at = now(), last_sync_error = $3 WHERE org_id = $1 AND id = $2`, [
    orgId,
    id,
    error === null ? null : capError(error),
  ])
}

// ── Items ────────────────────────────────────────────────────────────────────

export interface BacklogItem {
  id: string
  orgId: string
  sourceId: string
  externalId: string
  title: string
  body: string
  url: string | null
  repoUrl: string | null
  baseBranch: string | null
  labels: string[]
  externalState: string
  state: ItemState
  stateNote: string | null
  position: number | null
  runId: string | null
  lastRunId: string | null
  builtBy: string | null
  pullRequestUrl: string | null
  dropAfterRun: boolean
  createdAt: string
  updatedAt: string
}

/** The editable fields of an item, as imported or re-synced from its source. Caps are applied here. */
export interface BacklogItemFields {
  title: string
  body?: string
  url?: string | null
  repoUrl?: string | null
  baseBranch?: string | null
  labels?: string[]
  externalState?: string
  position?: number | null
}

export interface BacklogItemEvent {
  id: number
  at: string
  kind: string
  data: Record<string, unknown>
}

interface ItemRow {
  id: string
  org_id: string
  source_id: string
  external_id: string
  title: string
  body: string
  url: string | null
  repo_url: string | null
  base_branch: string | null
  labels: string[]
  external_state: string
  state: ItemState
  state_note: string | null
  position: number | null
  run_id: string | null
  last_run_id: string | null
  built_by: string | null
  pull_request_url: string | null
  drop_after_run: boolean
  created_at: Date
  updated_at: Date
}

const ITEM_COLS =
  'id, org_id, source_id, external_id, title, body, url, repo_url, base_branch, labels, external_state, state, state_note, position, run_id, last_run_id, built_by, pull_request_url, drop_after_run, created_at, updated_at'
/** Fixed pipeline order items group by in listings; a SQL literal, not user input. */
const STATE_ORDER = `ARRAY[${ITEM_STATES.map((s) => `'${s}'`).join(',')}]::text[]`

const TITLE_MAX = 300
const BODY_MAX = 20_000
const LABELS_MAX = 20
const LABEL_MAX = 60
export const STATE_NOTE_MAX = 2000

const capTitle = (v: string) => v.slice(0, TITLE_MAX)
const capBody = (v: string) => v.slice(0, BODY_MAX)
const capLabels = (v: string[]) => v.slice(0, LABELS_MAX).map((l) => l.slice(0, LABEL_MAX))
const capNote = (v: string | null | undefined) => (v == null ? null : v.slice(0, STATE_NOTE_MAX))

/** Stored sync/write errors (source or write service messages) are capped so a verbose upstream failure can't bloat a row. */
export const SYNC_ERROR_MAX = 2000
const capError = (v: string) => v.slice(0, SYNC_ERROR_MAX)

/** `title ILIKE` search terms are user input: escape ILIKE's own wildcards so a search for "100%" or "a_b" matches literally. */
const escapeLikeTerm = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`)

function toItem(r: ItemRow): BacklogItem {
  return {
    id: r.id,
    orgId: r.org_id,
    sourceId: r.source_id,
    externalId: r.external_id,
    title: r.title,
    body: r.body,
    url: r.url,
    repoUrl: r.repo_url,
    baseBranch: r.base_branch,
    labels: r.labels,
    externalState: r.external_state,
    state: r.state,
    stateNote: r.state_note,
    position: r.position,
    runId: r.run_id,
    lastRunId: r.last_run_id,
    builtBy: r.built_by,
    pullRequestUrl: r.pull_request_url,
    dropAfterRun: r.drop_after_run,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  }
}

export async function listItems(
  q: Queryable,
  orgId: string,
  f: { state?: ItemState; sourceId?: string; q?: string; limit?: number } = {},
): Promise<BacklogItem[]> {
  const rows = await q.query<ItemRow>(
    `SELECT ${ITEM_COLS} FROM backlog_items
     WHERE org_id = $1
       AND ($2::text IS NULL OR state = $2)
       AND ($3::uuid IS NULL OR source_id = $3)
       AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%')
     ORDER BY array_position(${STATE_ORDER}, state), position NULLS LAST, created_at
     LIMIT $5`,
    [orgId, f.state ?? null, f.sourceId ?? null, f.q ? escapeLikeTerm(f.q) : null, Math.min(f.limit ?? 100, 500)],
  )
  return rows.map(toItem)
}

export async function getItem(q: Queryable, orgId: string, id: string): Promise<BacklogItem | null> {
  const [row] = await q.query<ItemRow>(`SELECT ${ITEM_COLS} FROM backlog_items WHERE org_id = $1 AND id = $2`, [orgId, id])
  return row ? toItem(row) : null
}

export async function listItemEvents(q: Queryable, orgId: string, itemId: string): Promise<BacklogItemEvent[]> {
  const rows = await q.query<{ id: string | number; at: Date; kind: string; data: Record<string, unknown> }>(
    `SELECT id, at, kind, data FROM backlog_item_events WHERE org_id = $1 AND item_id = $2 ORDER BY at DESC, id DESC LIMIT 200`,
    [orgId, itemId],
  )
  return rows.map((r) => ({ id: Number(r.id), at: iso(r.at)!, kind: r.kind, data: r.data }))
}

/**
 * Inserts a new item under `sourceId`. The source must belong to `orgId` —
 * enforced in the same statement (an INSERT ... SELECT gated on that match)
 * rather than a separate lookup, so a caller can never race its way around
 * the check, and a source id from another org fails loudly instead of
 * silently creating a cross-tenant row.
 */
export async function insertItem(
  q: Queryable,
  orgId: string,
  sourceId: string,
  externalId: string,
  fields: BacklogItemFields,
  state: ItemState,
): Promise<BacklogItem> {
  const [row] = await q.query<ItemRow>(
    `INSERT INTO backlog_items (org_id, source_id, external_id, title, body, url, repo_url, base_branch, labels, external_state, position, state)
     SELECT $1, bs.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     FROM backlog_sources bs WHERE bs.id = $2 AND bs.org_id = $1
     RETURNING ${ITEM_COLS}`,
    [
      orgId,
      sourceId,
      externalId,
      capTitle(fields.title),
      capBody(fields.body ?? ''),
      fields.url ?? null,
      fields.repoUrl ?? null,
      fields.baseBranch ?? null,
      capLabels(fields.labels ?? []),
      fields.externalState ?? '',
      fields.position ?? null,
      state,
    ],
  )
  if (!row) throw new Error(`Backlog source ${sourceId} does not belong to this org`)
  return toItem(row)
}

export async function updateItemFields(q: Queryable, orgId: string, itemId: string, fields: Partial<BacklogItemFields>): Promise<BacklogItem | null> {
  const [row] = await q.query<ItemRow>(
    `UPDATE backlog_items SET
       title = coalesce($3, title),
       body = coalesce($4, body),
       url = CASE WHEN $5::boolean THEN $6 ELSE url END,
       repo_url = CASE WHEN $7::boolean THEN $8 ELSE repo_url END,
       base_branch = CASE WHEN $9::boolean THEN $10 ELSE base_branch END,
       labels = coalesce($11, labels),
       external_state = coalesce($12, external_state),
       position = CASE WHEN $13::boolean THEN $14 ELSE position END,
       updated_at = now()
     WHERE org_id = $1 AND id = $2 RETURNING ${ITEM_COLS}`,
    [
      orgId,
      itemId,
      fields.title !== undefined ? capTitle(fields.title) : null,
      fields.body !== undefined ? capBody(fields.body) : null,
      fields.url !== undefined,
      fields.url ?? null,
      fields.repoUrl !== undefined,
      fields.repoUrl ?? null,
      fields.baseBranch !== undefined,
      fields.baseBranch ?? null,
      fields.labels !== undefined ? capLabels(fields.labels) : null,
      fields.externalState !== undefined ? fields.externalState : null,
      fields.position !== undefined,
      fields.position ?? null,
    ],
  )
  return row ? toItem(row) : null
}

export async function addItemEvent(q: Queryable, orgId: string, itemId: string, kind: string, data: Record<string, unknown> = {}): Promise<void> {
  await q.query(`INSERT INTO backlog_item_events (org_id, item_id, kind, data) VALUES ($1, $2, $3, $4)`, [orgId, itemId, kind, JSON.stringify(data)])
}

/**
 * Moves an item to `state`, recording the note and an event, and — when the
 * item's source writes that state back (`mapping.out[state]`) — queues a
 * status write (coalescing with any still-pending write for this item).
 */
export async function setItemState(
  q: Queryable,
  orgId: string,
  itemId: string,
  state: ItemState,
  opts: { note?: string | null; event: string; data?: Record<string, unknown> },
): Promise<BacklogItem | null> {
  const note = capNote(opts.note)
  const [row] = await q.query<ItemRow>(
    `UPDATE backlog_items SET state = $3, state_note = $4, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING ${ITEM_COLS}`,
    [orgId, itemId, state, note],
  )
  if (!row) return null
  const item = toItem(row)
  await addItemEvent(q, orgId, itemId, opts.event, opts.data ?? {})

  const [source] = await q.query<{ mapping: StatusMapping }>(`SELECT mapping FROM backlog_sources WHERE id = $1 AND org_id = $2`, [item.sourceId, orgId])
  if (source?.mapping.out[state]) {
    await q.query(
      `INSERT INTO backlog_writes (org_id, item_id, source_id, state, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id) WHERE done_at IS NULL AND failed_at IS NULL
       DO UPDATE SET state = excluded.state, note = excluded.note, attempts = 0, next_attempt_at = now()`,
      [orgId, itemId, item.sourceId, state, note],
    )
  }
  return item
}

/** Leases an item to a run: sets `run_id` and moves it to `planning`. */
export async function leaseItem(q: Queryable, orgId: string, itemId: string, runId: string): Promise<BacklogItem | null> {
  await q.query(`UPDATE backlog_items SET run_id = $3, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, itemId, runId])
  return setItemState(q, orgId, itemId, 'planning', { event: 'picked', data: { runId } })
}

/** Marks a leased item to drop once its run finishes (engine/engine.ts finishItemRun reads this flag). */
export async function markDropAfterRun(q: Queryable, orgId: string, itemId: string): Promise<void> {
  await q.query(`UPDATE backlog_items SET drop_after_run = true, updated_at = now() WHERE org_id = $1 AND id = $2`, [orgId, itemId])
}

/** System context: ready items (not leased, enabled source, matching filters), locked for the scheduler. */
export async function pickReadyItems(
  q: Queryable,
  orgId: string,
  filter: { sourceIds?: string[]; labels?: string[] },
  limit: number,
): Promise<BacklogItem[]> {
  const rows = await q.query<ItemRow>(
    `SELECT ${prefixed(ITEM_COLS, 'bi')} FROM backlog_items bi
     JOIN backlog_sources bs ON bs.id = bi.source_id
     WHERE bi.org_id = $1 AND bi.state = 'ready' AND bi.run_id IS NULL AND bs.enabled
       AND ($2::uuid[] IS NULL OR bi.source_id = ANY($2))
       AND ($3::text[] IS NULL OR bi.labels @> $3)
     ORDER BY bi.position NULLS LAST, bi.created_at
     FOR UPDATE OF bi SKIP LOCKED
     LIMIT $4`,
    [orgId, filter.sourceIds ?? null, filter.labels ?? null, limit],
  )
  return rows.map(toItem)
}

/** What a finished run means for the backlog item it was leased to (engine/engine.ts finishRun). */
export interface BacklogRunOutcome {
  status: 'succeeded' | 'failed' | 'canceled'
  /** A step output's `pullRequest.url`, when the run produced one. */
  pullRequestUrl?: string
  /** 'factory-task' | 'factory-orchestration' | 'routini', when a PR was produced. */
  builtBy?: string
  /** The run's own error, for a failed run. */
  error?: string
}

/**
 * Applies the run-end rules of §5: done (with a PR), blocked (no PR, failed or
 * canceled), or dropped (the item was marked to drop while leased). Always
 * clears `run_id`, sets `last_run_id`, and records a `run.finished` event.
 */
export async function finishItemRun(
  q: Queryable,
  orgId: string,
  itemId: string,
  run: { id: string; number: number },
  outcome: BacklogRunOutcome,
): Promise<BacklogItem | null> {
  const item = await getItem(q, orgId, itemId)
  if (!item) return null

  let state: ItemState
  let note: string | null
  let pullRequestUrl = item.pullRequestUrl
  let builtBy = item.builtBy
  if (outcome.status === 'succeeded' && outcome.pullRequestUrl) {
    state = 'done'
    note = null
    pullRequestUrl = outcome.pullRequestUrl
    builtBy = outcome.builtBy ?? 'routini'
  } else if (outcome.status === 'succeeded') {
    state = 'blocked'
    note = `Run #${run.number} finished without opening a pull request`
  } else if (outcome.status === 'failed') {
    state = 'blocked'
    note = outcome.error ?? null
  } else {
    state = 'blocked'
    note = `Canceled in run #${run.number}`
  }
  if (item.dropAfterRun) {
    state = 'dropped'
    note = 'Dropped at the source while a run had it'
  }

  await q.query(
    `UPDATE backlog_items SET run_id = NULL, last_run_id = $3, pull_request_url = $4, built_by = $5, drop_after_run = false, updated_at = now()
     WHERE org_id = $1 AND id = $2`,
    [orgId, itemId, run.id, pullRequestUrl, builtBy],
  )
  return setItemState(q, orgId, itemId, state, { note, event: 'run.finished', data: { runId: run.id, number: run.number, status: outcome.status } })
}

// ── Status writes ────────────────────────────────────────────────────────────

export interface BacklogWrite {
  id: string
  orgId: string
  itemId: string
  sourceId: string
  state: ItemState
  note: string | null
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  doneAt: string | null
  failedAt: string | null
  createdAt: string
}

export interface FailedWrite {
  id: string
  itemId: string
  itemTitle: string
  sourceName: string
  state: ItemState
  lastError: string | null
  attempts: number
  failedAt: string
}

interface WriteRow {
  id: string
  org_id: string
  item_id: string
  source_id: string
  state: ItemState
  note: string | null
  attempts: number
  next_attempt_at: Date
  last_error: string | null
  done_at: Date | null
  failed_at: Date | null
  created_at: Date
}

const WRITE_COLS = 'id, org_id, item_id, source_id, state, note, attempts, next_attempt_at, last_error, done_at, failed_at, created_at'
const MAX_WRITE_ATTEMPTS = 8
const MAX_RETRY_DELAY_MIN = 60

function toWrite(r: WriteRow): BacklogWrite {
  return {
    id: r.id,
    orgId: r.org_id,
    itemId: r.item_id,
    sourceId: r.source_id,
    state: r.state,
    note: r.note,
    attempts: r.attempts,
    nextAttemptAt: iso(r.next_attempt_at)!,
    lastError: r.last_error,
    doneAt: iso(r.done_at),
    failedAt: iso(r.failed_at),
    createdAt: iso(r.created_at)!,
  }
}

/** System context: due writes (pending, next_attempt_at reached), locked and pushed out for the attempt. */
export async function claimDueWrites(q: Queryable, limit: number): Promise<BacklogWrite[]> {
  const rows = await q.query<WriteRow>(
    `WITH due AS (
       SELECT id FROM backlog_writes WHERE done_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
       ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE backlog_writes w SET next_attempt_at = now() + interval '5 minutes'
     FROM due WHERE w.id = due.id RETURNING ${prefixed(WRITE_COLS, 'w')}`,
    [limit],
  )
  return rows.map(toWrite)
}

export async function completeWrite(q: Queryable, orgId: string, id: string): Promise<void> {
  await q.query(`UPDATE backlog_writes SET done_at = now() WHERE org_id = $1 AND id = $2`, [orgId, id])
}

/** Bumps attempts with exponential backoff (capped at 60 minutes); fails the write at 8 attempts. */
export async function retryWrite(q: Queryable, orgId: string, id: string, error: string): Promise<void> {
  await q.query(
    `UPDATE backlog_writes SET
       attempts = attempts + 1,
       last_error = $3,
       next_attempt_at = CASE WHEN attempts + 1 >= $4 THEN next_attempt_at ELSE now() + make_interval(mins => LEAST($5, power(2, attempts))::int) END,
       failed_at = CASE WHEN attempts + 1 >= $4 THEN now() ELSE failed_at END
     WHERE org_id = $1 AND id = $2`,
    [orgId, id, capError(error), MAX_WRITE_ATTEMPTS, MAX_RETRY_DELAY_MIN],
  )
}

export async function listFailedWrites(q: Queryable, orgId: string): Promise<FailedWrite[]> {
  const rows = await q.query<{
    id: string
    item_id: string
    item_title: string
    source_name: string
    state: ItemState
    last_error: string | null
    attempts: number
    failed_at: Date
  }>(
    `SELECT w.id, w.item_id, bi.title AS item_title, bs.name AS source_name, w.state, w.last_error, w.attempts, w.failed_at
     FROM backlog_writes w
     JOIN backlog_items bi ON bi.id = w.item_id
     JOIN backlog_sources bs ON bs.id = w.source_id
     WHERE w.org_id = $1 AND w.failed_at IS NOT NULL
     ORDER BY w.failed_at DESC`,
    [orgId],
  )
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemTitle: r.item_title,
    sourceName: r.source_name,
    state: r.state,
    lastError: r.last_error,
    attempts: r.attempts,
    failedAt: iso(r.failed_at)!,
  }))
}

export async function resetWrite(q: Queryable, orgId: string, id: string): Promise<boolean> {
  const rows = await q.query(
    `UPDATE backlog_writes SET failed_at = NULL, attempts = 0, next_attempt_at = now() WHERE org_id = $1 AND id = $2 AND failed_at IS NOT NULL RETURNING id`,
    [orgId, id],
  )
  return rows.length > 0
}
