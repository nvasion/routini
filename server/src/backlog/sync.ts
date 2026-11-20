// ─────────────────────────────────────────────────────────────────────────────
// Syncing backlog sources: fetches each due source through its adapter and
// applies the import/update rules of docs/work-intake-backlog.md section 7.
//
// Repository data (an item's repoUrl/baseBranch) comes straight from the
// tracker — untrusted, like alert labels — so it is re-validated here the
// same way a job spec validates an agent step's repo (utils/repoUrl.ts):
// anything that doesn't pass is dropped to null and recorded as a
// `repo.ignored` event instead of silently reaching Docker later
// (engine/prepare.ts re-checks it again when a run actually resolves it).
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { AppContext } from '../http/common.js'
import {
  addItemEvent,
  claimDueSources,
  getItemsByExternalIds,
  insertItem,
  markDropAfterRun,
  recordSync,
  setItemState,
  updateItemFields,
  type BacklogItemFields,
  type BacklogSource,
} from '../repos/backlog.js'
import { isValidBranchName, validateRepoUrl } from '../utils/repoUrl.js'
import { adapterCtx, requireConnected } from './context.js'
import { getAdapter } from './index.js'
import { matchesAny } from './mapping.js'
import type { SourceItem } from './types.js'

/** `repoUrl`/`baseBranch` kept only when they pass the same checks a job spec's repo does; otherwise null + the dropped value, for `repo.ignored`. */
export function sanitizeRepo(item: SourceItem): { repoUrl: string | null; baseBranch: string | null; ignored: string[] } {
  const ignored: string[] = []
  let repoUrl: string | null = null
  if (item.repoUrl) {
    if (validateRepoUrl(item.repoUrl).valid) repoUrl = item.repoUrl
    else ignored.push(item.repoUrl)
  }
  let baseBranch: string | null = null
  if (item.baseBranch) {
    if (isValidBranchName(item.baseBranch)) baseBranch = item.baseBranch
    else ignored.push(item.baseBranch)
  }
  return { repoUrl, baseBranch, ignored }
}

function itemFields(sourceItem: SourceItem, repoUrl: string | null, baseBranch: string | null): BacklogItemFields {
  const fields: BacklogItemFields = {
    title: sourceItem.title,
    body: sourceItem.body,
    url: sourceItem.url ?? null,
    repoUrl,
    baseBranch,
    labels: sourceItem.labels,
    externalState: sourceItem.state,
  }
  if (sourceItem.position !== undefined) fields.position = sourceItem.position ?? null
  return fields
}

async function applyFetchedItems(q: Queryable, source: BacklogSource, fetched: SourceItem[]): Promise<{ imported: number; updated: number }> {
  // Look up exactly what was fetched: a capped listing would miss older items once a
  // source has more than its cap, and re-inserting them would hit the unique key.
  const known = await getItemsByExternalIds(
    q,
    source.orgId,
    source.id,
    fetched.map((f) => f.externalId),
  )
  const byExternalId = new Map(known.map((item) => [item.externalId, item]))

  let imported = 0
  let updated = 0
  for (const sourceItem of fetched) {
    const { repoUrl, baseBranch, ignored } = sanitizeRepo(sourceItem)
    const fields = itemFields(sourceItem, repoUrl, baseBranch)
    const existing = byExternalId.get(sourceItem.externalId)

    if (!existing) {
      // A new item is only imported when its external status already reads as ready; anything else is ignored.
      if (!matchesAny(sourceItem.state, source.mapping.in.ready)) continue
      const item = await insertItem(q, source.orgId, source.id, sourceItem.externalId, fields, 'ready')
      await addItemEvent(q, source.orgId, item.id, 'imported', {})
      for (const value of ignored) await addItemEvent(q, source.orgId, item.id, 'repo.ignored', { value })
      imported++
      continue
    }

    await updateItemFields(q, source.orgId, existing.id, fields)
    for (const value of ignored) await addItemEvent(q, source.orgId, existing.id, 'repo.ignored', { value })

    if (matchesAny(sourceItem.state, source.mapping.in.ready)) {
      if (!existing.runId && (existing.state === 'blocked' || existing.state === 'dropped' || existing.state === 'done')) {
        await setItemState(q, source.orgId, existing.id, 'ready', { event: 'ready.source', note: `Set ready in ${source.name}` })
      }
    } else if (matchesAny(sourceItem.state, source.mapping.in.dropped)) {
      if (existing.runId) await markDropAfterRun(q, source.orgId, existing.id)
      else await setItemState(q, source.orgId, existing.id, 'dropped', { event: 'dropped.source' })
    }
    // A known item missing from the fetch, or matching neither list, is left alone.
    updated++
  }
  return { imported, updated }
}

/**
 * Fetches `source` through its adapter and applies the import/update rules.
 * Network and adapter errors never throw: they are recorded on the source
 * (`recordSync`) so "Sync now" in the console shows the failure, and the
 * counts reflect whatever was applied before the failure (0 on a fetch error).
 */
export async function syncSource(app: AppContext, source: BacklogSource): Promise<{ imported: number; updated: number }> {
  let imported = 0
  let updated = 0
  let error: string | null = null
  try {
    const adapter = getAdapter(source.kind)
    const ctx = adapterCtx(app, source.orgId)
    await requireConnected(ctx, adapter.integration)
    const fetched = await adapter.fetch(ctx, source.config)
    ;({ imported, updated } = await app.db.org(source.orgId, (q) => applyFetchedItems(q, source, fetched)))
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  await app.db.org(source.orgId, (q) => recordSync(q, source.orgId, source.id, error))
  return { imported, updated }
}

/** Claims every due source and syncs each; one source's failure never stops the others. */
export async function syncTick(app: AppContext): Promise<void> {
  const sources = await app.db.system((q) => claimDueSources(q, 10))
  for (const source of sources) {
    try {
      await syncSource(app, source)
    } catch (err) {
      console.error(`[backlog] sync tick: source ${source.id} failed:`, err instanceof Error ? err.message : err)
    }
  }
}
