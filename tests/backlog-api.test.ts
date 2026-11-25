// The backlog HTTP API end to end: source CRUD/test/sync, items, status writes,
// and the scheduler -> run -> write loop. Contract: docs/work-intake-backlog.md
// sections 7-8. A fake fetch stands in for api.monday.com (and api.github.com,
// unused by these scenarios but wired the same way) so sync/write/test all run
// through the real adapters against recorded, in-memory board state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { schedulerTick } from '../server/src/engine/scheduler'
import { syncSource, sanitizeRepo } from '../server/src/backlog/sync'
import { writesTick } from '../server/src/backlog/writes'
import { finishItemRun, getSource, leaseItem, retryWrite, setItemState, type StatusMapping } from '../server/src/repos/backlog'
import type { StepExecutor } from '../server/src/engine/types'
import type { FetchFn } from '../server/src/integrations/providers'

// ── Fake monday.com / GitHub ─────────────────────────────────────────────────

interface BoardItem {
  id: string
  name: string
  url?: string
  groupId?: string
  status: string
  repo?: string
}

let board: BoardItem[] = []
let statusWrites: { itemId: string; value: string }[] = []
let comments: { itemId: string; body: string }[] = []
/** Number of upcoming `change_simple_column_value` calls to answer with HTTP 500 (simulates a flaky write). */
let writeFailures = 0

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response
}

const integrationFetch: FetchFn = async (url, init) => {
  const u = new URL(url)
  if (u.hostname === 'api.github.com') return jsonResponse(200, {})
  if (u.hostname !== 'api.monday.com') throw new Error(`unexpected fetch host ${u.hostname}`)

  const { query, variables } = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, string> }
  if (query.includes('items_page')) {
    return jsonResponse(200, {
      data: {
        boards: [
          {
            items_page: {
              items: board.map((b) => ({
                id: b.id,
                name: b.name,
                url: b.url ?? null,
                group: { id: b.groupId ?? 'g1' },
                column_values: [{ id: 'status', text: b.status }, ...(b.repo !== undefined ? [{ id: 'repo', text: b.repo }] : [])],
              })),
            },
          },
        ],
      },
    })
  }
  if (query.includes('change_simple_column_value')) {
    if (writeFailures > 0) {
      writeFailures--
      return jsonResponse(500, {})
    }
    const item = board.find((b) => b.id === variables['itemId'])
    if (item) item.status = variables['value']!
    statusWrites.push({ itemId: variables['itemId']!, value: variables['value']! })
    return jsonResponse(200, { data: { change_simple_column_value: { id: variables['itemId'] } } })
  }
  if (query.includes('create_update')) {
    comments.push({ itemId: variables['itemId']!, body: variables['body']! })
    return jsonResponse(200, { data: { create_update: { id: '1' } } })
  }
  throw new Error(`unexpected monday query: ${query}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MAPPING: StatusMapping = {
  out: { blocked: { value: 'Blocked', comment: true }, dropped: { value: 'Archived' }, done: { value: 'Done', comment: true } },
  in: { ready: ['Ready'], dropped: ['Cancelled'] },
}

let t: TestApp
let u: TestUser
const base = () => `/api/orgs/${u.orgSlug}`

async function connectMonday(user: TestUser) {
  const res = await user.put(`/api/orgs/${user.orgSlug}/integrations/monday`, { credentials: { apiToken: 'tok' } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
}

async function createMondaySource(user: TestUser, overrides: Record<string, unknown> = {}) {
  const res = await user.post(`/api/orgs/${user.orgSlug}/backlog/sources`, {
    name: 'board',
    kind: 'monday',
    config: { boardId: '1', statusColumnId: 'status', repoColumnId: 'repo' },
    mapping: MAPPING,
    ...overrides,
  })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.source as { id: string; name: string }
}

async function makeRun(user: TestUser) {
  const job = await user.post(`/api/orgs/${user.orgSlug}/jobs`, { name: 'carrier', steps: [{ kind: 'approval', config: { message: 'm' } }] })
  const run = await user.post(`/api/orgs/${user.orgSlug}/jobs/${job.body.job.id}/run`)
  return run.body.run as { id: string; number: number }
}

beforeEach(async () => {
  board = []
  statusWrites = []
  comments = []
  writeFailures = 0
  t = await makeTestApp({ engine: { actions: { integrationFetch } } })
  u = await t.signup('backlog-api@example.com')
  await connectMonday(u)
})
afterEach(async () => {
  await t.close()
})

// ── Sources: create, validation, test, sync ──────────────────────────────────

describe('sources', () => {
  it('rejects a bad config with the adapter message', async () => {
    const res = await u.post(`${base()}/backlog/sources`, {
      name: 'board',
      kind: 'monday',
      config: { boardId: 'not-digits', statusColumnId: 'status' },
      mapping: MAPPING,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('config.boardId must be a string of digits')
  })

  it('rejects a mapping that would make an item loop', async () => {
    const res = await u.post(`${base()}/backlog/sources`, {
      name: 'board',
      kind: 'monday',
      config: { boardId: '1', statusColumnId: 'status' },
      mapping: { out: { blocked: { value: 'Ready' } }, in: { ready: ['Ready'], dropped: [] } },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("'Ready' is written for blocked and read as ready; items would loop")
  })

  it('previews items without saving anything', async () => {
    const src = await createMondaySource(u)
    board = [{ id: '1', name: 'Preview me', status: 'Ready' }]
    const res = await u.post(`${base()}/backlog/sources/${src.id}/test`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [expect.objectContaining({ externalId: '1', title: 'Preview me', state: 'Ready' })],
      total: 1,
      states: [{ value: 'Ready', count: 1 }],
    })
    expect((await u.get(`${base()}/backlog/items`)).body.items).toEqual([])
  })

  it('counts every status in the preview, including items past the 20 shown', async () => {
    const src = await createMondaySource(u)
    board = [
      ...Array.from({ length: 22 }, (_, i) => ({ id: String(i + 1), name: `New ${i + 1}`, status: 'New' })),
      { id: '100', name: 'Doing', status: 'Active' },
      { id: '101', name: 'Also doing', status: 'Active' },
    ]
    const res = await u.post(`${base()}/backlog/sources/${src.id}/test`)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(20)
    expect(res.body.total).toBe(24)
    expect(res.body.states).toEqual([
      { value: 'New', count: 22 },
      { value: 'Active', count: 2 },
    ])
  })

  it('says which integration to connect when the source has none, instead of the tracker\'s auth error', async () => {
    const other = await t.signup('no-monday@example.com')
    const src = await createMondaySource(other)
    board = [{ id: '1', name: 'Ready one', status: 'Ready' }]
    const res = await other.post(`/api/orgs/${other.orgSlug}/backlog/sources/${src.id}/sync`)
    expect(res.status).toBe(200)
    expect(res.body.source.lastSyncError).toBe('The monday.com integration is not connected (Integrations → monday.com)')
  })

  it('imports only items matching in.ready on first sync', async () => {
    const src = await createMondaySource(u)
    board = [
      { id: '1', name: 'Ready one', status: 'Ready' },
      { id: '2', name: 'Not ready', status: 'In Progress' },
    ]
    const res = await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    expect(res.status).toBe(200)
    const items = (await u.get(`${base()}/backlog/items?sourceId=${src.id}`)).body.items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ externalId: '1', title: 'Ready one', state: 'ready' })
  })

  it('a second sync updates fields and applies ready.source / dropped.source (and drop_after_run when leased)', async () => {
    const src = await createMondaySource(u)
    board = [{ id: '10', name: 'Task', groupId: 'g', status: 'Ready' }]
    await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    const [imported] = (await u.get(`${base()}/backlog/items?sourceId=${src.id}`)).body.items
    const itemId = imported.id as string

    // A prior run left it blocked; the tracker now reads ready again.
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, itemId, 'blocked', { event: 'x' }))
    board[0]!.name = 'Task renamed'
    await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    const after1 = (await u.get(`${base()}/backlog/items/${itemId}`)).body.item
    expect(after1).toMatchObject({ title: 'Task renamed', state: 'ready', stateNote: `Set ready in ${src.name}` })

    // The tracker now reads dropped, and the item is not leased: it drops immediately.
    board[0]!.status = 'Cancelled'
    await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    const after2 = (await u.get(`${base()}/backlog/items/${itemId}`)).body.item
    expect(after2.state).toBe('dropped')

    // Leased, then the tracker reads dropped: drop_after_run instead of an immediate drop.
    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, itemId, 'ready', { event: 'reset-for-test' }))
    const run = await makeRun(u)
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, itemId, run.id))
    board[0]!.status = 'Cancelled'
    await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    const after3 = (await u.get(`${base()}/backlog/items/${itemId}`)).body.item
    expect(after3).toMatchObject({ state: 'planning', dropAfterRun: true, runId: run.id })
  })

  it('records repo.ignored and stores null when a synced repoUrl is not a safe git host', async () => {
    const src = await createMondaySource(u)
    board = [{ id: '1', name: 'A', status: 'Ready', repo: 'https://evil.example.com/a/b' }]
    await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    const [item] = (await u.get(`${base()}/backlog/items?sourceId=${src.id}`)).body.items
    expect(item.repoUrl).toBeNull()
    const detail = await u.get(`${base()}/backlog/items/${item.id}`)
    expect(detail.body.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'repo.ignored', data: { value: 'https://evil.example.com/a/b' } })]),
    )
  })
})

// ── sync.ts: sanitizeRepo (hardening 1) ──────────────────────────────────────

describe('sanitizeRepo', () => {
  const base_ = { externalId: '1', title: 't', body: '', url: null, state: '', labels: [] }

  it('keeps a valid repoUrl/baseBranch', () => {
    expect(sanitizeRepo({ ...base_, repoUrl: 'https://github.com/a/b', baseBranch: 'main' })).toEqual({
      repoUrl: 'https://github.com/a/b',
      baseBranch: 'main',
      ignored: [],
    })
  })

  it('drops an unsafe repoUrl and a traversal-shaped baseBranch, recording both', () => {
    const result = sanitizeRepo({ ...base_, repoUrl: 'ftp://evil.example.com/a/b', baseBranch: '../../etc' })
    expect(result.repoUrl).toBeNull()
    expect(result.baseBranch).toBeNull()
    expect(result.ignored).toEqual(['ftp://evil.example.com/a/b', '../../etc'])
  })
})

// ── Items: ready, drop, start ─────────────────────────────────────────────────

describe('items', () => {
  async function readyItem(): Promise<{ id: string; sourceId: string; sourceName: string }> {
    const src = await createMondaySource(u)
    board = [{ id: '1', name: 'A', status: 'Ready' }]
    await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    const [item] = (await u.get(`${base()}/backlog/items?sourceId=${src.id}`)).body.items
    return { id: item.id, sourceId: src.id, sourceName: src.name }
  }

  it('sets ready only from blocked or dropped, else 409', async () => {
    const { id } = await readyItem()
    const refused = await u.post(`${base()}/backlog/items/${id}/ready`)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('Only a blocked or dropped item can be set ready')

    await t.ctx.db.org(u.orgId, (q) => setItemState(q, u.orgId, id, 'blocked', { event: 'x' }))
    const ok = await u.post(`${base()}/backlog/items/${id}/ready`)
    expect(ok.status).toBe(200)
    expect(ok.body.item.state).toBe('ready')
  })

  it('start now: 400 for a job without backlog, 409 when leased', async () => {
    const { id } = await readyItem()
    const plainJob = (await u.post(`${base()}/jobs`, { name: 'plain', steps: [{ kind: 'approval', config: { message: 'm' } }] })).body.job

    const bad = await u.post(`${base()}/backlog/items/${id}/start`, { jobId: plainJob.id })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("That job doesn't take backlog items")

    const backlogJob = (
      await u.post(`${base()}/jobs`, {
        name: 'picker',
        trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC', backlog: { maxPerFire: 1 } },
        steps: [{ kind: 'approval', config: { message: 'm' } }],
      })
    ).body.job

    const started = await u.post(`${base()}/backlog/items/${id}/start`, { jobId: backlogJob.id })
    expect(started.status, JSON.stringify(started.body)).toBe(201)

    const again = await u.post(`${base()}/backlog/items/${id}/start`, { jobId: backlogJob.id })
    expect(again.status).toBe(409)
  })
})

// ── Status writes ─────────────────────────────────────────────────────────────

describe('writes', () => {
  async function blockedItemWithRun(): Promise<{ itemId: string; run: { id: string; number: number } }> {
    const src = await createMondaySource(u)
    board = [{ id: '1', name: 'A', status: 'Ready' }]
    await u.post(`${base()}/backlog/sources/${src.id}/sync`)
    const [item] = (await u.get(`${base()}/backlog/items?sourceId=${src.id}`)).body.items
    const run = await makeRun(u)
    await t.ctx.db.org(u.orgId, (q) => leaseItem(q, u.orgId, item.id, run.id))
    await t.ctx.db.org(u.orgId, (q) => finishItemRun(q, u.orgId, item.id, run, { status: 'failed', error: 'boom' }))
    return { itemId: item.id as string, run }
  }

  it('writes the mapped value with a comment containing the run link', async () => {
    const { itemId, run } = await blockedItemWithRun()
    await writesTick(t.ctx)
    expect(statusWrites).toEqual([{ itemId: '1', value: 'Blocked' }])
    expect(comments).toHaveLength(1)
    expect(comments[0]!.itemId).toBe('1')
    expect(comments[0]!.body).toContain('boom')
    expect(comments[0]!.body).toContain(`/o/${u.orgSlug}/runs/${run.number}`)
    void itemId
  })

  it('retries with backoff on a 500', async () => {
    const { itemId } = await blockedItemWithRun()
    writeFailures = 1
    await writesTick(t.ctx)
    const [row] = await t.ctx.db.org(u.orgId, (q) =>
      q.query<{ attempts: number; failed_at: string | null; next_attempt_at: string }>(
        'SELECT attempts, failed_at, next_attempt_at FROM backlog_writes WHERE item_id = $1',
        [itemId],
      ),
    )
    expect(row!.attempts).toBe(1)
    expect(row!.failed_at).toBeNull()
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('fails after 8 attempts, is listed in /inbox, and the retry endpoint resets it', async () => {
    const { itemId } = await blockedItemWithRun()
    const [{ id: writeId }] = await t.ctx.db.org(u.orgId, (q) => q.query<{ id: string }>('SELECT id FROM backlog_writes WHERE item_id = $1', [itemId]))

    for (let i = 0; i < 7; i++) await t.ctx.db.org(u.orgId, (q) => retryWrite(q, u.orgId, writeId!, 'nope'))
    await t.ctx.db.org(u.orgId, (q) => q.query('UPDATE backlog_writes SET next_attempt_at = now() WHERE id = $1', [writeId]))

    writeFailures = 1
    await writesTick(t.ctx)
    const [failed] = await t.ctx.db.org(u.orgId, (q) =>
      q.query<{ attempts: number; failed_at: string | null }>('SELECT attempts, failed_at FROM backlog_writes WHERE id = $1', [writeId]),
    )
    expect(failed!.attempts).toBe(8)
    expect(failed!.failed_at).not.toBeNull()

    const inbox = await u.get(`${base()}/inbox`)
    expect(inbox.body.backlogWrites).toEqual([expect.objectContaining({ id: writeId, itemId, state: 'blocked', attempts: 8 })])

    const retried = await u.post(`${base()}/backlog/writes/${writeId}/retry`)
    expect(retried.status).toBe(200)
    expect(retried.body).toEqual({ ok: true })
    const [reset] = await t.ctx.db.org(u.orgId, (q) =>
      q.query<{ attempts: number; failed_at: string | null }>('SELECT attempts, failed_at FROM backlog_writes WHERE id = $1', [writeId]),
    )
    expect(reset).toMatchObject({ attempts: 0, failed_at: null })
  })
})

// ── End to end: sync -> scheduler -> run -> write ─────────────────────────────

describe('end to end', () => {
  it('syncs a monday item, the scheduler runs it, the run opens a PR, and writesTick posts done back to monday', async () => {
    const prExecutor: StepExecutor = {
      async execute() {
        return { status: 'succeeded', output: { pullRequest: { url: 'https://github.com/x/y/pull/9' } } }
      },
    }
    const t2 = await makeTestApp({ engine: { actions: { integrationFetch }, executors: { agent: prExecutor } } })
    try {
      const u2 = await t2.signup('e2e@example.com')
      await connectMonday(u2)
      board = [{ id: '42', name: 'Ship it', groupId: 'g', status: 'Ready' }]
      const src = await createMondaySource(u2)
      await u2.post(`/api/orgs/${u2.orgSlug}/backlog/sources/${src.id}/sync`)
      const [item] = (await u2.get(`/api/orgs/${u2.orgSlug}/backlog/items?sourceId=${src.id}`)).body.items

      const jobRes = await u2.post(`/api/orgs/${u2.orgSlug}/jobs`, {
        name: 'picker',
        trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC', backlog: { maxPerFire: 1 } },
        steps: [{ kind: 'agent', config: { agent: 'claude', prompt: 'build it' } }],
      })
      const job = jobRes.body.job
      await schedulerTick(t2.ctx.db, new Date(new Date(job.nextRunAt).getTime() + 1000))
      await new Worker(t2.ctx, t2.ctx.engine, { heartbeatMs: 20, concurrency: 4 }).drain()

      const finished = (await u2.get(`/api/orgs/${u2.orgSlug}/backlog/items/${item.id}`)).body.item
      expect(finished).toMatchObject({ state: 'done', pullRequestUrl: 'https://github.com/x/y/pull/9', builtBy: 'routini' })

      await writesTick(t2.ctx)
      expect(statusWrites.find((w) => w.itemId === '42')).toEqual({ itemId: '42', value: 'Done' })
    } finally {
      await t2.close()
    }
  })
})

describe('syncSource', () => {
  it('returns imported/updated counts and records the sync attempt', async () => {
    const src = await createMondaySource(u)
    board = [{ id: '1', name: 'A', status: 'Ready' }]
    const full = await t.ctx.db.org(u.orgId, (q) => getSource(q, u.orgId, src.id))
    const result = await syncSource(t.ctx, full!)
    expect(result).toEqual({ imported: 1, updated: 0 })
    expect((await t.ctx.db.org(u.orgId, (q) => getSource(q, u.orgId, src.id)))!.lastSyncError).toBeNull()
  })
})
