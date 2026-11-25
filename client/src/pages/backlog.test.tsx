// Backlog page, rendered through the real routes with a mocked API
// (the HTTP API itself ships in wave B; see console.test.tsx for the pattern).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { baseRoutes, mockFetch, renderAt } from '../test/harness'
import type { BacklogItem, BacklogSource, Job } from '../lib/types'
import { eventLabel, httpUrl } from './BacklogPage'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SOURCE: BacklogSource = {
  id: 'src1',
  orgId: 'o1',
  name: 'Product board',
  kind: 'monday',
  config: { boardId: '123', statusColumnId: 'status' },
  mapping: { out: { blocked: { value: 'Blocked' } }, in: { ready: ['Ready'], dropped: [] } },
  defaultRepoUrl: null,
  defaultBaseBranch: 'main',
  factoryProjectId: null,
  enabled: true,
  syncEveryMin: 5,
  nextSyncAt: '2026-11-20T00:05:00Z',
  lastSyncAt: '2026-11-20T00:00:00Z',
  lastSyncError: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}

const ITEM: BacklogItem = {
  id: 'it1',
  orgId: 'o1',
  sourceId: 'src1',
  externalId: 'board-1',
  title: 'Fix login bug',
  body: '',
  url: 'https://monday.com/boards/123/pulses/1',
  repoUrl: null,
  baseBranch: null,
  labels: [],
  externalState: 'Blocked',
  state: 'blocked',
  stateNote: 'Run #3 finished without opening a pull request',
  position: 1,
  runId: null,
  lastRunId: 'run-9',
  builtBy: null,
  pullRequestUrl: null,
  dropAfterRun: false,
  createdAt: '2026-11-18T00:00:00Z',
  updatedAt: '2026-11-19T00:00:00Z',
}

const JOB: Job = {
  id: 'j1',
  name: 'Build from backlog',
  description: '',
  trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC', backlog: { maxPerFire: 5 } },
  steps: [],
  enabled: true,
  nextRunAt: null,
  createdAt: '',
  updatedAt: '',
}

describe('backlog page', () => {
  it('lists sources and items, opens an item, and sets it ready', async () => {
    let item = ITEM
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/backlog/sources': () => ({ sources: [SOURCE] }),
        'GET /api/orgs/acme/backlog/items': () => ({ items: [item] }),
        'GET /api/orgs/acme/backlog/items/it1': () => ({ item, source: SOURCE, events: [{ id: 'e1', at: '2026-11-18T00:00:00Z', kind: 'imported', data: {} }] }),
        'GET /api/orgs/acme/jobs': () => ({ jobs: [JOB] }),
        'POST /api/orgs/acme/backlog/items/it1/ready': () => {
          item = { ...item, state: 'ready', stateNote: null }
          return { item }
        },
      }),
    )

    renderAt('/o/acme/backlog')
    const main = await screen.findByRole('main')

    // Source chip: name and a Sync now button (the item row below also names its source).
    await waitFor(() => expect(within(main).getAllByText('Product board').length).toBeGreaterThan(0))
    expect(within(main).getByRole('button', { name: 'Sync now' })).toBeTruthy()

    // Items table.
    await within(main).findByText('Fix login bug')

    // Open the item panel.
    fireEvent.click(within(main).getByText('Fix login bug'))
    await within(main).findByText('Run #3 finished without opening a pull request')
    expect(within(main).getByRole('link', { name: 'source' })).toBeTruthy()

    // Set ready.
    fireEvent.click(within(main).getByRole('button', { name: 'Set ready' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'POST')).toBe(true))
    const post = log.calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/orgs/acme/backlog/items/it1/ready')
  })

  it('syncs a source from its chip', async () => {
    let synced = false
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/backlog/sources': () => ({ sources: [{ ...SOURCE, lastSyncError: synced ? null : 'boom' }] }),
        'GET /api/orgs/acme/backlog/items': () => ({ items: [] }),
        'POST /api/orgs/acme/backlog/sources/src1/sync': () => {
          synced = true
          return { source: { ...SOURCE, lastSyncError: null } }
        },
      }),
    )
    renderAt('/o/acme/backlog')
    const main = await screen.findByRole('main')
    await within(main).findByText('boom')
    fireEvent.click(within(main).getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'POST' && c.url === '/api/orgs/acme/backlog/sources/src1/sync')).toBe(true))
    await within(main).findByText(/No items yet\. A source imports an item only when its status counts as ready/)
  })
})

describe('Backlog source editor: Test preview', () => {
  it('shows each item\'s status and what a sync would do, and lets you pick what a status counts as', async () => {
    mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/backlog/sources': () => ({ sources: [{ ...SOURCE, kind: 'azure-boards', config: { project: 'Shop' }, mapping: { out: {}, in: { ready: ['Ready'], dropped: [] } } }] }),
        'GET /api/orgs/acme/backlog/items': () => ({ items: [] }),
        'POST /api/orgs/acme/backlog/sources/src1/test': () => ({
          items: [
            { externalId: '1', title: 'Checkout story', body: '', url: null, state: 'New', labels: [] },
            { externalId: '2', title: 'Search story', body: '', url: null, state: 'Active', labels: [] },
          ],
          total: 2,
          states: [
            { value: 'Active', count: 1 },
            { value: 'New', count: 1 },
          ],
        }),
      }),
    )
    renderAt('/o/acme/backlog')
    const main = await screen.findByRole('main')
    fireEvent.click(await within(main).findByRole('button', { name: 'Product board' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }))

    const result = await within(dialog).findByLabelText('Test result')
    // The status shows on each item (it used to come back blank).
    expect(within(result).getAllByText('New').length).toBeGreaterThan(0)
    expect(within(result).getAllByText('Ignored').length).toBeGreaterThan(0)
    expect(result.textContent).toContain('so a sync imports nothing yet')

    fireEvent.change(within(result).getByLabelText('What "New" counts as'), { target: { value: 'ready' } })
    expect((within(dialog).getByLabelText('Counts as ready') as HTMLInputElement).value).toBe('Ready, New')
    expect(within(result).getByText('Imports as ready')).toBeTruthy()
    expect(result.textContent).toContain('will be imported on the next sync')
    expect(result.textContent).toContain('Save to apply your changes.')
  })
})

describe('httpUrl', () => {
  it('only lets http(s) tracker URLs become links', () => {
    expect(httpUrl('https://northwind.monday.com/boards/1/pulses/2')).toBe('https://northwind.monday.com/boards/1/pulses/2')
    expect(httpUrl('javascript:alert(1)')).toBeNull()
    expect(httpUrl('data:text/html,hi')).toBeNull()
    expect(httpUrl('not a url')).toBeNull()
    expect(httpUrl(null)).toBeNull()
  })
})

describe('eventLabel', () => {
  it('puts item events in words', () => {
    expect(eventLabel({ kind: 'imported', data: {} }, 'Northwind shop board')).toBe('Imported from Northwind shop board')
    expect(eventLabel({ kind: 'run.finished', data: { number: 12, status: 'failed' } }, 's')).toBe('Run #12 failed')
    expect(eventLabel({ kind: 'run.finished', data: { number: 13, status: 'succeeded' } }, 's')).toBe('Run #13 finished')
    expect(eventLabel({ kind: 'ready.source', data: {} }, 'northwind/roadmap')).toBe('Set ready in northwind/roadmap')
    expect(eventLabel({ kind: 'dropped.manual', data: {} }, 's')).toBe('Dropped in Routini')
    expect(eventLabel({ kind: 'something.new', data: {} }, 's')).toBe('something.new')
  })
})
