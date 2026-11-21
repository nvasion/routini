/**
 * Unit tests for the Linear backlog source adapter (server/src/backlog/linear.ts).
 * A pure module: no database, no real network. Every test supplies a recording
 * fake `fetch` so the adapter is exercised exactly as the scheduler's sync/write
 * ticks would call it (contract: docs/work-intake-backlog.md section 6b).
 */

import { describe, it, expect } from 'vitest'
import { SpecError } from '../server/src/engine/spec'
import { linearAdapter, parseLinearConfig } from '../server/src/backlog/linear'
import type { AdapterCtx } from '../server/src/backlog/types'
import type { FetchFn } from '../server/src/integrations/providers'

// ── Fake fetch ────────────────────────────────────────────────────────────────

interface FakeResponse {
  status: number
  json: unknown
}

interface RecordedCall {
  method: string
  url: string
  body: any
  headers: Record<string, string>
}

/** A fetch that answers from a fixed queue of responses, in call order, and records every call. */
function fakeFetch(responses: FakeResponse[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body, headers: (init?.headers as Record<string, string>) ?? {} })
    const r = responses[Math.min(i, responses.length - 1)]!
    i += 1
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.json,
    } as unknown as Response
  }) as FetchFn
  return { fetch, calls }
}

function ctxWith(fetch: FetchFn, creds: Record<string, Record<string, string>>): AdapterCtx {
  return {
    fetch,
    credentials: async (integration) => creds[integration] ?? {},
    allowPrivateHosts: false,
  }
}

function issuesPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): FakeResponse {
  return {
    status: 200,
    json: { data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } },
  }
}

const item = { externalId: 'issue-1', title: 'Fix the thing', url: null }

// ── parseConfig ───────────────────────────────────────────────────────────────

describe('parseLinearConfig', () => {
  it('accepts a valid teamKey with no labels', () => {
    const cfg = parseLinearConfig({ teamKey: 'ENG' })
    expect(cfg).toEqual({ teamKey: 'ENG' })
  })

  it('accepts labels', () => {
    const cfg = parseLinearConfig({ teamKey: 'ENG', labels: ['bug', 'urgent'] })
    expect(cfg.labels).toEqual(['bug', 'urgent'])
  })

  it('rejects a non-object config', () => {
    expect(() => parseLinearConfig(null)).toThrow(SpecError)
    expect(() => parseLinearConfig('nope')).toThrow('config must be an object')
  })

  it('rejects a teamKey that does not match the pattern', () => {
    expect(() => parseLinearConfig({ teamKey: 'eng' })).toThrow('config.teamKey must match ^[A-Z][A-Z0-9]{0,9}$')
    expect(() => parseLinearConfig({ teamKey: 'ENGINEERING1' })).toThrow('config.teamKey must match ^[A-Z][A-Z0-9]{0,9}$')
    expect(() => parseLinearConfig({ teamKey: '1ENG' })).toThrow('config.teamKey must match ^[A-Z][A-Z0-9]{0,9}$')
    expect(() => parseLinearConfig({})).toThrow('config.teamKey must match ^[A-Z][A-Z0-9]{0,9}$')
  })

  it('rejects labels that are not a list of 0-20 strings of at most 60 characters', () => {
    expect(() => parseLinearConfig({ teamKey: 'ENG', labels: 'bug' })).toThrow(
      'config.labels must be a list of 0-20 non-empty strings of at most 60 characters',
    )
    expect(() => parseLinearConfig({ teamKey: 'ENG', labels: [''] })).toThrow(
      'config.labels must be a list of 0-20 non-empty strings of at most 60 characters',
    )
    expect(() => parseLinearConfig({ teamKey: 'ENG', labels: ['x'.repeat(61)] })).toThrow(
      'config.labels must be a list of 0-20 non-empty strings of at most 60 characters',
    )
    expect(() => parseLinearConfig({ teamKey: 'ENG', labels: Array.from({ length: 21 }, (_, i) => `l${i}`) })).toThrow(
      'config.labels must be a list of 0-20 non-empty strings of at most 60 characters',
    )
  })
})

// ── fetch ─────────────────────────────────────────────────────────────────────

describe('linear adapter fetch', () => {
  it('sends the team filter in query variables and the raw apiKey as `authorization`', async () => {
    const { fetch, calls } = fakeFetch([issuesPage([])])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'lin_api_secret' } })
    const cfg = parseLinearConfig({ teamKey: 'ENG' })

    await linearAdapter.fetch(ctx, cfg)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.linear.app/graphql')
    expect(calls[0]!.headers.authorization).toBe('lin_api_secret')
    expect(calls[0]!.headers.authorization).not.toContain('Bearer')
    expect(calls[0]!.body.variables).toEqual({ filter: { team: { key: { eq: 'ENG' } } }, after: null })
  })

  it('includes the labels filter in variables when labels are configured', async () => {
    const { fetch, calls } = fakeFetch([issuesPage([])])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })
    const cfg = parseLinearConfig({ teamKey: 'ENG', labels: ['bug', 'urgent'] })

    await linearAdapter.fetch(ctx, cfg)

    expect(calls[0]!.body.variables.filter).toEqual({
      team: { key: { eq: 'ENG' } },
      labels: { name: { in: ['bug', 'urgent'] } },
    })
  })

  it('maps issue fields to a SourceItem', async () => {
    const { fetch } = fakeFetch([
      issuesPage([
        {
          id: 'issue-1',
          title: 'Fix the thing',
          description: 'Some details',
          url: 'https://linear.app/acme/issue/ENG-1',
          state: { name: 'In Progress' },
          labels: { nodes: [{ name: 'bug' }, { name: 'urgent' }] },
        },
      ]),
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })
    const cfg = parseLinearConfig({ teamKey: 'ENG' })

    const items = await linearAdapter.fetch(ctx, cfg)

    expect(items).toEqual([
      {
        externalId: 'issue-1',
        title: 'Fix the thing',
        body: 'Some details',
        url: 'https://linear.app/acme/issue/ENG-1',
        state: 'In Progress',
        labels: ['bug', 'urgent'],
        position: 0,
      },
    ])
  })

  it('keeps only issues carrying every configured label', async () => {
    const { fetch } = fakeFetch([
      issuesPage([
        { id: '1', title: 'Has both', description: '', url: null, state: { name: 'Todo' }, labels: { nodes: [{ name: 'bug' }, { name: 'urgent' }] } },
        { id: '2', title: 'Has one', description: '', url: null, state: { name: 'Todo' }, labels: { nodes: [{ name: 'bug' }] } },
        { id: '3', title: 'Has none', description: '', url: null, state: { name: 'Todo' }, labels: { nodes: [] } },
      ]),
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })
    const cfg = parseLinearConfig({ teamKey: 'ENG', labels: ['bug', 'urgent'] })

    const items = await linearAdapter.fetch(ctx, cfg)

    expect(items.map((i) => i.externalId)).toEqual(['1'])
  })

  it('pages through `after` until hasNextPage is false', async () => {
    const { fetch, calls } = fakeFetch([
      issuesPage([{ id: '1', title: 'A', description: '', url: null, state: { name: 'Todo' }, labels: { nodes: [] } }], true, 'cursor-1'),
      issuesPage([{ id: '2', title: 'B', description: '', url: null, state: { name: 'Todo' }, labels: { nodes: [] } }], false, null),
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })
    const cfg = parseLinearConfig({ teamKey: 'ENG' })

    const items = await linearAdapter.fetch(ctx, cfg)

    expect(items.map((i) => i.externalId)).toEqual(['1', '2'])
    expect(items.map((i) => i.position)).toEqual([0, 1])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.variables.after).toBeNull()
    expect(calls[1]!.body.variables.after).toBe('cursor-1')
  })

  it('stops paging once 500 items have been collected', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `p1-${i}`,
      title: 'x',
      description: '',
      url: null,
      state: { name: 'Todo' },
      labels: { nodes: [] },
    }))
    const responses: FakeResponse[] = []
    for (let p = 0; p < 5; p++) {
      responses.push(issuesPage(page1.map((n) => ({ ...n, id: `p${p}-${n.id}` })), true, `cursor-${p}`))
    }
    // A sixth page that must never be fetched because 500 is reached after 5 pages of 100.
    responses.push(issuesPage([{ id: 'should-not-appear', title: 'x', description: '', url: null, state: { name: 'Todo' }, labels: { nodes: [] } }], true, 'cursor-5'))
    const { fetch, calls } = fakeFetch(responses)
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })
    const cfg = parseLinearConfig({ teamKey: 'ENG' })

    const items = await linearAdapter.fetch(ctx, cfg)

    expect(items).toHaveLength(500)
    expect(calls).toHaveLength(5)
    expect(items.some((i) => i.externalId === 'should-not-appear')).toBe(false)
  })

  it('surfaces the first GraphQL error', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { errors: [{ message: 'Team not found' }, { message: 'second' }] } }])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })
    const cfg = parseLinearConfig({ teamKey: 'ENG' })

    await expect(linearAdapter.fetch(ctx, cfg)).rejects.toThrow('Team not found')
  })
})

// ── write ─────────────────────────────────────────────────────────────────────

function statesResponse(stateNodes: { id: string; name: string }[]): FakeResponse {
  return { status: 200, json: { data: { teams: { nodes: [{ states: { nodes: stateNodes } }] } } } }
}

describe('linear adapter write', () => {
  const cfg = parseLinearConfig({ teamKey: 'ENG' })

  it('looks up the workflow state by name and calls issueUpdate with its id', async () => {
    const { fetch, calls } = fakeFetch([
      statesResponse([{ id: 'state-todo', name: 'Todo' }, { id: 'state-done', name: 'Done' }]),
      { status: 200, json: { data: { issueUpdate: { success: true } } } },
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })

    await linearAdapter.write(ctx, cfg, item, { value: 'done' })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.variables).toEqual({ teamKey: 'ENG' })
    expect(calls[1]!.body.variables).toEqual({ id: 'issue-1', stateId: 'state-done' })
  })

  it('matches the state name case-insensitively', async () => {
    const { fetch, calls } = fakeFetch([
      statesResponse([{ id: 'state-in-progress', name: 'In Progress' }]),
      { status: 200, json: { data: { issueUpdate: { success: true } } } },
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })

    await linearAdapter.write(ctx, cfg, item, { value: 'IN PROGRESS' })

    expect(calls[1]!.body.variables.stateId).toBe('state-in-progress')
  })

  it('throws the "No workflow state" message naming the value and team when none matches', async () => {
    const { fetch, calls } = fakeFetch([statesResponse([{ id: 'state-todo', name: 'Todo' }])])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })

    await expect(linearAdapter.write(ctx, cfg, item, { value: 'Archived' })).rejects.toThrow(
      "No workflow state 'Archived' in team ENG",
    )
    // Only the states lookup happened; no issueUpdate was attempted.
    expect(calls).toHaveLength(1)
  })

  it('also posts a comment via commentCreate when one is given', async () => {
    const { fetch, calls } = fakeFetch([
      statesResponse([{ id: 'state-done', name: 'Done' }]),
      { status: 200, json: { data: { issueUpdate: { success: true } } } },
      { status: 200, json: { data: { commentCreate: { success: true } } } },
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })

    await linearAdapter.write(ctx, cfg, item, { value: 'Done', comment: 'Shipped it' })

    expect(calls).toHaveLength(3)
    expect(calls[2]!.body.variables).toEqual({ issueId: 'issue-1', body: 'Shipped it' })
  })

  it('does not post a comment when none is given', async () => {
    const { fetch, calls } = fakeFetch([
      statesResponse([{ id: 'state-done', name: 'Done' }]),
      { status: 200, json: { data: { issueUpdate: { success: true } } } },
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })

    await linearAdapter.write(ctx, cfg, item, { value: 'Done' })

    expect(calls).toHaveLength(2)
  })

  it('sends the raw apiKey as `authorization` on write calls too', async () => {
    const { fetch, calls } = fakeFetch([
      statesResponse([{ id: 'state-done', name: 'Done' }]),
      { status: 200, json: { data: { issueUpdate: { success: true } } } },
    ])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'lin_write_secret' } })

    await linearAdapter.write(ctx, cfg, item, { value: 'Done' })

    expect(calls[0]!.headers.authorization).toBe('lin_write_secret')
    expect(calls[1]!.headers.authorization).toBe('lin_write_secret')
  })

  it('surfaces the first GraphQL error on write', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { errors: [{ message: 'Invalid team key' }] } }])
    const ctx = ctxWith(fetch, { linear: { apiKey: 'k' } })

    await expect(linearAdapter.write(ctx, cfg, item, { value: 'Done' })).rejects.toThrow('Invalid team key')
  })
})
