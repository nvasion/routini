// repos/backlog.ts: sources and items CRUD, state transitions (and the status
// writes they queue), the scheduler's claim functions, and write retry/backoff.
// Contract: docs/work-intake-backlog.md §§2-3.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import {
  addItemEvent,
  claimDueSources,
  claimDueWrites,
  completeWrite,
  createSource,
  deleteSource,
  finishItemRun,
  getItem,
  getSource,
  insertItem,
  leaseItem,
  listFailedWrites,
  listItemEvents,
  listItems,
  listSources,
  pickReadyItems,
  recordSync,
  resetWrite,
  retryWrite,
  setItemState,
  updateItemFields,
  updateSource,
  type StatusMapping,
} from '../server/src/repos/backlog'

let t: TestApp
let u: TestUser

beforeEach(async () => {
  t = await makeTestApp()
  u = await t.signup('backlog@example.com')
})
afterEach(async () => {
  await t.close()
})

const MAPPING_NONE: StatusMapping = { out: {}, in: { ready: ['Ready'], dropped: ['Dropped'] } }
const MAPPING_BLOCKED: StatusMapping = { out: { blocked: { value: 'Blocked' } }, in: { ready: ['Ready'], dropped: ['Dropped'] } }
const MAPPING_COMMENT: StatusMapping = { out: { done: { value: 'Done', comment: true } }, in: { ready: ['Ready'], dropped: ['Dropped'] } }

let sourceSeq = 0
function source(mapping: StatusMapping = MAPPING_NONE, extra: Partial<Parameters<typeof createSource>[2]> = {}) {
  sourceSeq++
  return t.ctx.db.org(u.orgId, (q) =>
    createSource(q, u.orgId, { name: extra.name ?? `repo spec ${sourceSeq}`, kind: 'repo', config: { repoUrl: 'https://github.com/a/b' }, mapping, ...extra }),
  )
}
function item(sourceId: string, externalId = 'f1.md', fields: Partial<Parameters<typeof insertItem>[4]> = {}, state: 'ready' = 'ready') {
  return t.ctx.db.org(u.orgId, (q) => insertItem(q, u.orgId, sourceId, externalId, { title: 'Fix the thing', ...fields }, state))
}

/** A real run row (leaseItem/finishItemRun need run_id to satisfy the FK to runs). */
async function makeRun(): Promise<{ id: string; number: number }> {
  const job = await u.post(`/api/orgs/${u.orgSlug}/jobs`, { name: 'carrier', steps: [{ kind: 'approval', config: { message: 'm' } }] })
  const run = await u.post(`/api/orgs/${u.orgSlug}/jobs/${job.body.job.id}/run`)
  return run.body.run as { id: string; number: number }
}

// ── Sources ──────────────────────────────────────────────────────────────────

describe('sources', () => {
  it('creates, lists, updates and deletes', async () => {
    const s = await source(MAPPING_NONE, { name: 'repo spec' })
    expect(s).toMatchObject({ name: 'repo spec', kind: 'repo', enabled: true, defaultBaseBranch: 'main', syncEveryMin: 5 })

    const listed = await t.ctx.db.org(u.orgId, (q) => listSources(q, u.orgId))
    expect(listed.map((x) => x.id)).toEqual([s.id])

    const updated = await t.ctx.db.org(u.orgId, (q) => updateSource(q, u.orgId, s.id, { name: 'renamed', enabled: false, syncEveryMin: 10 }))
    expect(updated).toMatchObject({ name: 'renamed', enabled: false, syncEveryMin: 10, kind: 'repo' })

    expect(await t.ctx.db.org(u.orgId, (q) => deleteSource(q, u.orgId, s.id))).toBe(true)
    expect(await t.ctx.db.org(u.orgId, (q) => getSource(q, u.orgId, s.id))).toBeNull()
  })

  it('isolates sources between orgs', async () => {
    const s = await source()
    const other = await t.signup('other-source@example.com')
    expect(await t.ctx.db.org(other.orgId, (q) => getSource(q, other.orgId, s.id))).toBeNull()
    expect(await t.ctx.db.org(other.orgId, (q) => listSources(q, other.orgId))).toEqual([])
  })

  it('records a sync attempt (ok or error)', async () => {
    const s = await source()
    await t.ctx.db.org(u.orgId, (q) => recordSync(q, u.orgId, s.id, null))
    expect((await t.ctx.db.org(u.orgId, (q) => getSource(q, u.orgId, s.id)))!.lastSyncError).toBeNull()
    await t.ctx.db.org(u.orgId, (q) => recordSync(q, u.orgId, s.id, 'board not found'))
    const after = await t.ctx.db.org(u.orgId, (q) => getSource(q, u.orgId, s.id))
    expect(after!.lastSyncError).toBe('board not found')
    expect(after!.lastSyncAt).not.toBeNull()
  })

  // Hardening (wave A security review, item 3): a verbose upstream error can't bloat the row.
  it('caps a stored sync error at 2000 characters', async () => {
    const s = await source()
    const huge = 'x'.repeat(5000)
    await t.ctx.db.org(u.orgId, (q) => recordSync(q, u.orgId, s.id, huge))
    const after = await t.ctx.db.org(u.orgId, (q) => getSource(q, u.orgId, s.id))
    expect(after!.lastSyncError).toHaveLength(2000)
  })
})

// ── Items: CRUD ──────────────────────────────────────────────────────────────

describe('items: CRUD', () => {
  it('inserts, reads, updates fields and lists with filters', async () => {
    const s = await source()
    const a = await item(s.id, 'a.md', { labels: ['bug', 'p1'] })
    const b = await item(s.id, 'b.md', { title: 'Another task' })

    expect(await t.ctx.db.org(u.orgId, (q) => getItem(q, u.orgId, a.id))).toMatchObject({ title: 'Fix the thing', labels: ['bug', 'p1'], state: 'ready' })

    const updated = await t.ctx.db.org(u.orgId, (q) => updateItemFields(q, u.orgId, a.id, { title: 'Fix the other thing', url: 'https://x/1' }))
    expect(updated).toMatchObject({ title: 'Fix the other thing', url: 'https://x/1', labels: ['bug', 'p1'] })

    const bySource = await t.ctx.db.org(u.orgId, (q) => listItems(q, u.orgId, { sourceId: s.id }))
    expect(bySource.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())

    const search = await t.ctx.db.org(u.orgId, (q) => listItems(q, u.orgId, { q: 'another' }))
    expect(search.map((x) => x.id)).toEqual([b.id])

    const byState = await t.ctx.db.org(u.orgId, (q) => listItems(q, u.orgId, { state: 'ready' }))
    expect(byState).toHaveLength(2)
  })

  // Hardening (wave A security review, item 4): a search term's own ILIKE wildcards (% and _)
  // are escaped, so they match literally instead of acting as "any characters" / "any character".
  it('escapes % and _ in the search term instead of treating them as ILIKE wildcards', async () => {
    const s = await source()
    const underscore = await item(s.id, 'u.md', { title: 'a_b item' })
    const wouldWildcardMatch = await item(s.id, 'w.md', { title: 'axb item' })
    const found = await t.ctx.db.org(u.orgId, (q) => listItems(q, u.orgId, { q: 'a_b' }))
    expect(found.map((x) => x.id)).toEqual([underscore.id])
    void wouldWildcardMatch
  })

  // Hardening (wave A security review, item 2): insertItem refuses a sourceId that
  // belongs to a different org, even when called with that org's own orgId.
  it('insertItem refuses a sourceId belonging to another org', async () => {
    const s = await source()
    const other = await t.signup('other-insert@example.com')
    await expect(t.ctx.db.org(other.orgId, (q) => insertItem(q, other.orgId, s.id, 'x', { title: 'nope' }, 'ready'))).rejects.toThrow()
  })

  it('orders listings by pipeline stage, then position, then creation', async () => {
    const s = await source()
    const ready2 = await item(s.id, 'ready2.md', { position: 2 })
    const ready1 = await item(s.id, 'ready1.md', { position: 1 })
    const planning = await item(s.id, 'planning.md')
    const run = await makeRun()
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, planning.id, run.id))

    const list = await t.ctx.db.org(u.orgId, (q) => listItems(q, u.orgId, {}))
    expect(list.map((x) => x.id)).toEqual([ready1.id, ready2.id, planning.id])
  })

  it('caps title, body and labels on insert and update', async () => {
    const s = await source()
    const big = await item(s.id, 'big.md', {
      title: 'x'.repeat(400),
      body: 'y'.repeat(25_000),
      labels: Array.from({ length: 30 }, (_, i) => `label-${i}-${'z'.repeat(80)}`),
    })
    expect(big.title.length).toBe(300)
    expect(big.body.length).toBe(20_000)
    expect(big.labels).toHaveLength(20)
    expect(big.labels.every((l) => l.length <= 60)).toBe(true)

    const updated = await t.ctx.db.org(u.orgId, (q) => updateItemFields(q, u.orgId, big.id, { title: 'w'.repeat(400) }))
    expect(updated!.title.length).toBe(300)
  })

  it('records and lists events, newest first', async () => {
    const s = await source()
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => addItemEvent(q, u.orgId, a.id, 'imported', {}))
    await t.ctx.db.org(u.orgId, (q) => addItemEvent(q, u.orgId, a.id, 'synced', { n: 1 }))
    const events = await t.ctx.db.org(u.orgId, (q) => listItemEvents(q, u.orgId, a.id))
    expect(events.map((e) => e.kind)).toEqual(['synced', 'imported'])
    expect(events[0]!.data).toEqual({ n: 1 })
  })
})

// ── setItemState: writes, coalescing ─────────────────────────────────────────

describe('setItemState', () => {
  it('updates state and note, and records the event', async () => {
    const s = await source()
    const a = await item(s.id)
    const updated = await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { note: 'needs a human', event: 'run.finished', data: { n: 1 } }))
    expect(updated).toMatchObject({ state: 'blocked', stateNote: 'needs a human' })
    const events = await t.ctx.db.org(u.orgId, (q) => listItemEvents(q, u.orgId, a.id))
    expect(events[0]).toMatchObject({ kind: 'run.finished', data: { n: 1 } })
  })

  it('queues a write only when the source maps that state', async () => {
    const noWrite = await source(MAPPING_NONE)
    const a = await item(noWrite.id, 'a.md')
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    expect(await t.ctx.db.system((q) => claimDueWrites(q, 10))).toHaveLength(0)

    const withWrite = await source(MAPPING_BLOCKED)
    const b = await item(withWrite.id, 'b.md')
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, b.id, 'blocked', { note: 'oops', event: 'x' }))
    const due = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({ itemId: b.id, state: 'blocked', note: 'oops', attempts: 0 })
  })

  it('coalesces into the one pending write per item instead of piling up', async () => {
    const s = await source(MAPPING_BLOCKED)
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { note: 'first', event: 'x' }))
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { note: 'second', event: 'x' }))
    const rows = await t.ctx.db.org(u.orgId, (q) => q.query('SELECT note FROM backlog_writes WHERE item_id = $1', [a.id]))
    expect(rows).toHaveLength(1)
    expect((rows[0] as { note: string }).note).toBe('second')
  })

  it("opens a new write once the pending one is done or failed (doesn't coalesce into a closed write)", async () => {
    const s = await source(MAPPING_BLOCKED)
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    const [first] = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    await t.ctx.db.org(u.orgId, (q) => completeWrite(q, u.orgId, first!.id))
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    const rows = await t.ctx.db.org(u.orgId, (q) => q.query('SELECT id FROM backlog_writes WHERE item_id = $1', [a.id]))
    expect(rows).toHaveLength(2)
  })

  it('a missing item is a no-op, not an error', async () => {
    const s = await source()
    expect(await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, '00000000-0000-0000-0000-000000000099', 'blocked', { event: 'x' }))).toBeNull()
    void s
  })

  // Hardening (wave A security review, item 2): the source mapping lookup is scoped to the
  // item's own org, so it can never queue a write using another org's mapping — even if an
  // item's source_id somehow pointed outside its org (insertItem now refuses to create that
  // state; this guards the read path too, in case of an older row or a bug elsewhere).
  it("queues a write using only the item's own org's source mapping, never another org's", async () => {
    const otherOrg = await t.signup('other-mapping@example.com')
    const otherSource = await t.ctx.db.org(otherOrg.orgId, (q) =>
      createSource(q, otherOrg.orgId, { name: 'other', kind: 'repo', config: {}, mapping: MAPPING_BLOCKED }),
    )
    const mySource = await source(MAPPING_NONE)
    const a = await item(mySource.id, 'a.md')
    await t.ctx.db.system((q) => q.query('UPDATE backlog_items SET source_id = $1 WHERE id = $2', [otherSource.id, a.id]))

    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    expect(await t.ctx.db.system((q) => claimDueWrites(q, 10))).toHaveLength(0)
  })
})

// ── leaseItem, pickReadyItems ────────────────────────────────────────────────

describe('leasing', () => {
  it('leaseItem sets run_id and moves the item to planning, with a picked event', async () => {
    const s = await source()
    const a = await item(s.id)
    const run = await makeRun()
    const leased = await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, a.id, run.id))
    expect(leased).toMatchObject({ state: 'planning', runId: run.id })
    const events = await t.ctx.db.org(u.orgId, (q) => listItemEvents(q, u.orgId, a.id))
    expect(events[0]).toMatchObject({ kind: 'picked', data: { runId: run.id } })
  })

  it('pickReadyItems finds unleased ready items on enabled sources, filtered by source and labels', async () => {
    const enabled = await source()
    const disabled = await source(MAPPING_NONE, { name: 'disabled-src', enabled: false })
    const ready = await item(enabled.id, 'ready.md', { labels: ['p1'] })
    const noLabel = await item(enabled.id, 'nolabel.md')
    const onDisabled = await item(disabled.id, 'd.md')
    const leased = await item(enabled.id, 'leased.md')
    const run = await makeRun()
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, leased.id, run.id))

    const all = await t.ctx.db.system((q) => pickReadyItems(q, u.orgId, {}, 10))
    expect(all.map((x) => x.id).sort()).toEqual([ready.id, noLabel.id].sort())
    expect(all.some((x) => x.id === onDisabled.id)).toBe(false)
    expect(all.some((x) => x.id === leased.id)).toBe(false)

    const byLabel = await t.ctx.db.system((q) => pickReadyItems(q, u.orgId, { labels: ['p1'] }, 10))
    expect(byLabel.map((x) => x.id)).toEqual([ready.id])

    const bySource = await t.ctx.db.system((q) => pickReadyItems(q, u.orgId, { sourceIds: [disabled.id] }, 10))
    expect(bySource).toEqual([])

    const limited = await t.ctx.db.system((q) => pickReadyItems(q, u.orgId, {}, 1))
    expect(limited).toHaveLength(1)
  })
})

// ── finishItemRun ────────────────────────────────────────────────────────────

describe('finishItemRun', () => {
  it('a PR means done, with pull_request_url and built_by', async () => {
    const run = await makeRun()
    const s = await source()
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, a.id, run.id))
    const finished = await t.ctx.db.org(u.orgId, (q) =>
      finishItemRun(q, u.orgId, a.id, run, { status: 'succeeded', pullRequestUrl: 'https://github.com/a/b/pull/1', builtBy: 'factory-task' }),
    )
    expect(finished).toMatchObject({ state: 'done', runId: null, lastRunId: run.id, pullRequestUrl: 'https://github.com/a/b/pull/1', builtBy: 'factory-task' })
  })

  it('success without a PR blocks with a note naming the run', async () => {
    const run = await makeRun()
    const s = await source()
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, a.id, run.id))
    const finished = await t.ctx.db.org(u.orgId, (q) => finishItemRun(q, u.orgId, a.id, run, { status: 'succeeded' }))
    expect(finished).toMatchObject({ state: 'blocked', stateNote: `Run #${run.number} finished without opening a pull request` })
  })

  it('failure blocks with the run error', async () => {
    const run = await makeRun()
    const s = await source()
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, a.id, run.id))
    const finished = await t.ctx.db.org(u.orgId, (q) => finishItemRun(q, u.orgId, a.id, run, { status: 'failed', error: 'boom' }))
    expect(finished).toMatchObject({ state: 'blocked', stateNote: 'boom' })
  })

  it('cancellation blocks, naming the run', async () => {
    const run = await makeRun()
    const s = await source()
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, a.id, run.id))
    const finished = await t.ctx.db.org(u.orgId, (q) => finishItemRun(q, u.orgId, a.id, run, { status: 'canceled' }))
    expect(finished).toMatchObject({ state: 'blocked', stateNote: `Canceled in run #${run.number}` })
  })

  it('drop_after_run wins over any other outcome, and is cleared', async () => {
    const run = await makeRun()
    const s = await source()
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, a.id, run.id))
    await t.ctx.db.org(u.orgId, (q) => q.query('UPDATE backlog_items SET drop_after_run = true WHERE id = $1', [a.id]))
    const finished = await t.ctx.db.org(u.orgId, (q) =>
      finishItemRun(q, u.orgId, a.id, run, { status: 'succeeded', pullRequestUrl: 'https://github.com/a/b/pull/1' }),
    )
    expect(finished).toMatchObject({ state: 'dropped', stateNote: 'Dropped at the source while a run had it', dropAfterRun: false, runId: null })
  })
})

// ── Status writes: claiming, retries, failures ───────────────────────────────

describe('status writes', () => {
  it('claimDueSources claims only due, enabled sources and advances next_sync_at', async () => {
    const due = await source(MAPPING_NONE, { syncEveryMin: 7 })
    const notDue = await source(MAPPING_NONE, { name: 'future' })
    await t.ctx.db.system((q) => q.query("UPDATE backlog_sources SET next_sync_at = now() + interval '1 hour' WHERE id = $1", [notDue.id]))
    const disabled = await source(MAPPING_NONE, { name: 'off', enabled: false })

    const claimed = await t.ctx.db.system((q) => claimDueSources(q, 10))
    expect(claimed.map((x) => x.id)).toEqual([due.id])
    void disabled

    const after = await t.ctx.db.org(u.orgId, (q) => getSource(q, u.orgId, due.id))
    expect(new Date(after!.nextSyncAt).getTime()).toBeGreaterThan(Date.now() + 6 * 60_000)
  })

  it('claimDueWrites claims pending due writes and pushes next_attempt_at out', async () => {
    const s = await source(MAPPING_BLOCKED)
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    const claimed = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    expect(claimed).toHaveLength(1)
    expect(new Date(claimed[0]!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)
    // Not due again immediately.
    expect(await t.ctx.db.system((q) => claimDueWrites(q, 10))).toHaveLength(0)
  })

  it('completeWrite marks it done; it is never claimed again', async () => {
    const s = await source(MAPPING_BLOCKED)
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    const [w] = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    await t.ctx.db.org(u.orgId, (q) => completeWrite(q, u.orgId, w!.id))
    await t.ctx.db.org(u.orgId, (q) => q.query("UPDATE backlog_writes SET next_attempt_at = now() - interval '1 minute' WHERE id = $1", [w!.id]))
    expect(await t.ctx.db.system((q) => claimDueWrites(q, 10))).toHaveLength(0)
  })

  it('retryWrite backs off exponentially, capped at 60 minutes, and fails at 8 attempts', async () => {
    const s = await source(MAPPING_BLOCKED)
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    const [w] = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    const id = w!.id

    const row = async () => (await t.ctx.db.org(u.orgId, (q) => q.query('SELECT attempts, failed_at, next_attempt_at FROM backlog_writes WHERE id = $1', [id])))[0] as {
      attempts: number
      failed_at: string | null
      next_attempt_at: string
    }

    await t.ctx.db.org(u.orgId, (q) => retryWrite(q, u.orgId, id, 'network error'))
    let r = await row()
    expect(r.attempts).toBe(1)
    expect(r.failed_at).toBeNull()
    const delay1 = new Date(r.next_attempt_at).getTime() - Date.now()
    expect(delay1).toBeGreaterThan(0.5 * 60_000)
    expect(delay1).toBeLessThan(1.5 * 60_000)

    for (let i = 2; i <= 7; i++) {
      await t.ctx.db.org(u.orgId, (q) => retryWrite(q, u.orgId, id, 'network error'))
    }
    r = await row()
    expect(r.attempts).toBe(7)
    expect(r.failed_at).toBeNull()
    const delay7 = new Date(r.next_attempt_at).getTime() - Date.now()
    expect(delay7).toBeLessThan(61 * 60_000) // capped at 60 min, not 2^6 = 64

    await t.ctx.db.org(u.orgId, (q) => retryWrite(q, u.orgId, id, 'still broken'))
    r = await row()
    expect(r.attempts).toBe(8)
    expect(r.failed_at).not.toBeNull()
  })

  it('listFailedWrites reports failures with item title and source name; resetWrite clears them', async () => {
    const s = await source(MAPPING_BLOCKED, { name: 'spec-repo' })
    const a = await item(s.id, 'a.md', { title: 'Needs doing' })
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    const [w] = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    for (let i = 0; i < 8; i++) await t.ctx.db.org(u.orgId, (q) => retryWrite(q, u.orgId, w!.id, 'nope'))

    const failed = await t.ctx.db.org(u.orgId, (q) => listFailedWrites(q, u.orgId))
    expect(failed).toEqual([
      expect.objectContaining({ id: w!.id, itemId: a.id, itemTitle: 'Needs doing', sourceName: 'spec-repo', state: 'blocked', attempts: 8 }),
    ])

    expect(await t.ctx.db.org(u.orgId, (q) => resetWrite(q, u.orgId, w!.id))).toBe(true)
    expect(await t.ctx.db.org(u.orgId, (q) => listFailedWrites(q, u.orgId))).toEqual([])
    const reclaimed = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    expect(reclaimed.map((x) => x.id)).toEqual([w!.id])
    expect(reclaimed[0]!.attempts).toBe(0)
  })

  // Hardening (wave A security review, item 3): a verbose upstream error can't bloat the row.
  it('caps a stored write error at 2000 characters', async () => {
    const s = await source(MAPPING_BLOCKED)
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'blocked', { event: 'x' }))
    const [w] = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    await t.ctx.db.org(u.orgId, (q) => retryWrite(q, u.orgId, w!.id, 'x'.repeat(5000)))
    const [row] = await t.ctx.db.org(u.orgId, (q) => q.query<{ last_error: string }>('SELECT last_error FROM backlog_writes WHERE id = $1', [w!.id]))
    expect(row!.last_error).toHaveLength(2000)
  })

  it('writes a comment payload end to end through setItemState', async () => {
    const s = await source(MAPPING_COMMENT)
    const a = await item(s.id)
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, a.id, 'done', { note: 'shipped', event: 'run.finished' }))
    const [w] = await t.ctx.db.system((q) => claimDueWrites(q, 10))
    expect(w).toMatchObject({ itemId: a.id, state: 'done', note: 'shipped' })
  })
})
