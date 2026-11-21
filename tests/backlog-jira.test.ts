/**
 * Unit tests for the Jira backlog source adapter
 * (server/src/backlog/jira.ts). Pure module: no database, no real network —
 * every test supplies a recording fake `fetch` so the adapter is exercised
 * exactly as the scheduler's sync/write ticks would call it (contract:
 * docs/work-intake-backlog.md section 6b, "jira.ts").
 */

import { describe, it, expect, vi } from 'vitest'
import { SpecError } from '../server/src/engine/spec'
import { flattenAdf, jiraAdapter, parseJiraConfig, validateJiraSiteUrl, type JiraConfig } from '../server/src/backlog/jira'
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
  headers: Record<string, string>
  body: any
}

/** A fetch that answers from a fixed queue of responses, in call order, and records every call. */
function fakeFetch(responses: FakeResponse[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, headers: (init?.headers as Record<string, string>) ?? {}, body })
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

function ctxWith(fetch: FetchFn, creds: Record<string, string>, allowPrivateHosts = false): AdapterCtx {
  return {
    fetch,
    credentials: async () => creds,
    allowPrivateHosts,
  }
}

const SITE = 'https://acme.atlassian.net'
const CREDS = { siteUrl: SITE, email: 'bot@acme.com', apiToken: 'secret-token' }
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

const cfg = (overrides: Partial<JiraConfig> = {}): JiraConfig => parseJiraConfig({ jql: 'project = ROU', ...overrides })

function issuesPage(issues: unknown[], nextPageToken?: string): FakeResponse {
  return { status: 200, json: { issues, ...(nextPageToken ? { nextPageToken } : {}) } }
}

// ── parseJiraConfig ──────────────────────────────────────────────────────────

describe('parseJiraConfig', () => {
  it('requires a non-empty jql string', () => {
    expect(() => parseJiraConfig(null)).toThrow(SpecError)
    expect(() => parseJiraConfig({})).toThrow('config.jql must be a non-empty string of at most 2000 characters')
    expect(() => parseJiraConfig({ jql: '' })).toThrow('config.jql must be a non-empty string of at most 2000 characters')
    expect(() => parseJiraConfig({ jql: 'x'.repeat(2001) })).toThrow(
      'config.jql must be a non-empty string of at most 2000 characters',
    )
  })

  it('accepts a bare jql with no repoField', () => {
    const parsed = parseJiraConfig({ jql: 'project = ROU' })
    expect(parsed).toEqual({ jql: 'project = ROU' })
  })

  it('validates repoField when present', () => {
    expect(() => parseJiraConfig({ jql: 'x', repoField: '' })).toThrow(
      'config.repoField must be a non-empty string of at most 60 characters',
    )
    expect(() => parseJiraConfig({ jql: 'x', repoField: 'x'.repeat(61) })).toThrow(
      'config.repoField must be a non-empty string of at most 60 characters',
    )
    const parsed = parseJiraConfig({ jql: 'x', repoField: 'customfield_10050' })
    expect(parsed.repoField).toBe('customfield_10050')
  })
})

// ── flattenAdf ───────────────────────────────────────────────────────────────

describe('flattenAdf', () => {
  it('flattens an ADF doc to text, one line per top-level block', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second ' }, { type: 'text', text: 'line' }] },
      ],
    }
    expect(flattenAdf(doc)).toBe('First line\nSecond line')
  })

  it('returns an empty string for a missing or malformed doc', () => {
    expect(flattenAdf(undefined)).toBe('')
    expect(flattenAdf(null)).toBe('')
    expect(flattenAdf({ type: 'doc' })).toBe('')
  })
})

// ── validateJiraSiteUrl ──────────────────────────────────────────────────────

describe('validateJiraSiteUrl', () => {
  it('rejects a non-https site URL', async () => {
    await expect(validateJiraSiteUrl('http://acme.atlassian.net', false)).rejects.toThrow(
      'The Jira site URL must use https',
    )
  })

  it('rejects an invalid URL', async () => {
    await expect(validateJiraSiteUrl('not a url', false)).rejects.toThrow('The Jira site URL is not a valid URL')
  })

  it('rejects embedded credentials', async () => {
    await expect(validateJiraSiteUrl('https://user:pass@acme.atlassian.net', false)).rejects.toThrow(
      'The Jira site URL must not contain embedded credentials',
    )
  })

  it('rejects a hostname that is synchronously unsafe without consulting the DNS check', async () => {
    const dnsCheck = vi.fn(async () => true)
    await expect(validateJiraSiteUrl('https://10.0.0.5', false, dnsCheck)).rejects.toThrow(
      'The Jira site URL points at a private address',
    )
    expect(dnsCheck).not.toHaveBeenCalled()
  })

  it('rejects a public-looking hostname whose injected DNS check reports it unsafe', async () => {
    const dnsCheck = vi.fn(async () => false)
    await expect(validateJiraSiteUrl(SITE, false, dnsCheck)).rejects.toThrow(
      'The Jira site URL points at a private address',
    )
    expect(dnsCheck).toHaveBeenCalledWith('acme.atlassian.net')
  })

  it('accepts a public hostname whose injected DNS check reports it safe', async () => {
    const dnsCheck = vi.fn(async () => true)
    const url = await validateJiraSiteUrl(SITE, false, dnsCheck)
    expect(url.toString()).toBe(`${SITE}/`)
  })

  it('skips both SSRF checks entirely when private hosts are allowed', async () => {
    const dnsCheck = vi.fn(async () => false)
    const url = await validateJiraSiteUrl('https://10.0.0.5', true, dnsCheck)
    expect(url.hostname).toBe('10.0.0.5')
    expect(dnsCheck).not.toHaveBeenCalled()
  })
})

// ── adapter.fetch: site URL guard ────────────────────────────────────────────

describe('jiraAdapter.fetch site URL guard', () => {
  it('refuses a private site URL when private hosts are not allowed', async () => {
    const { fetch, calls } = fakeFetch([])
    const ctx = ctxWith(fetch, { ...CREDS, siteUrl: 'https://10.0.0.5' }, false)

    await expect(jiraAdapter.fetch(ctx, cfg())).rejects.toThrow('The Jira site URL points at a private address')
    expect(calls).toHaveLength(0)
  })

  it('accepts a private site URL when private hosts are allowed', async () => {
    const { fetch, calls } = fakeFetch([issuesPage([])])
    const ctx = ctxWith(fetch, { ...CREDS, siteUrl: 'https://10.0.0.5' }, true)

    await expect(jiraAdapter.fetch(ctx, cfg())).resolves.toEqual([])
    expect(calls).toHaveLength(1)
  })
})

// ── adapter.fetch: mapping, paging, repoField ───────────────────────────────

describe('jiraAdapter.fetch', () => {
  it('maps fields, flattens the ADF description, and reads the repoField when configured', async () => {
    const { fetch, calls } = fakeFetch([
      issuesPage([
        {
          key: 'ROU-1',
          fields: {
            summary: 'Fix the bug',
            description: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps to repro.' }] }],
            },
            status: { name: 'In Progress' },
            labels: ['bug', 'urgent'],
            customfield_10050: 'https://github.com/acme/app',
          },
        },
      ]),
    ])
    const ctx = ctxWith(fetch, CREDS)

    const items = await jiraAdapter.fetch(ctx, cfg({ repoField: 'customfield_10050' }))

    expect(items).toEqual([
      {
        externalId: 'ROU-1',
        title: 'Fix the bug',
        body: 'Steps to repro.',
        url: `${SITE}/browse/ROU-1`,
        state: 'In Progress',
        labels: ['bug', 'urgent'],
        repoUrl: 'https://github.com/acme/app',
        position: 0,
      },
    ])

    const call = calls[0]!
    expect(call.method).toBe('GET')
    const url = new URL(call.url)
    expect(url.pathname).toBe('/rest/api/3/search/jql')
    expect(url.searchParams.get('jql')).toBe('project = ROU')
    expect(url.searchParams.get('fields')).toBe('summary,description,status,labels,customfield_10050')
  })

  it('is null for repoUrl when repoField is not configured or is not a string value', async () => {
    const { fetch } = fakeFetch([
      issuesPage([{ key: 'ROU-2', fields: { summary: 'A', status: { name: 'Open' }, labels: [] } }]),
    ])
    const ctx = ctxWith(fetch, CREDS)

    const items = await jiraAdapter.fetch(ctx, cfg())
    expect(items[0]!.repoUrl).toBeNull()
  })

  it('pages with nextPageToken until a page has none', async () => {
    const { fetch, calls } = fakeFetch([
      issuesPage([{ key: 'ROU-1', fields: { summary: 'A', status: { name: 'Open' }, labels: [] } }], 'page-2'),
      issuesPage([{ key: 'ROU-2', fields: { summary: 'B', status: { name: 'Open' }, labels: [] } }]),
    ])
    const ctx = ctxWith(fetch, CREDS)

    const items = await jiraAdapter.fetch(ctx, cfg())

    expect(items.map((i) => i.externalId)).toEqual(['ROU-1', 'ROU-2'])
    expect(items.map((i) => i.position)).toEqual([0, 1])
    expect(calls).toHaveLength(2)
    expect(new URL(calls[0]!.url).searchParams.get('nextPageToken')).toBeNull()
    expect(new URL(calls[1]!.url).searchParams.get('nextPageToken')).toBe('page-2')
  })

  it('stops at 500 items even when more pages remain', async () => {
    const page = (n: number, start: number, nextPageToken?: string) =>
      issuesPage(
        Array.from({ length: n }, (_, i) => ({
          key: `ROU-${start + i}`,
          fields: { summary: 's', status: { name: 'Open' }, labels: [] },
        })),
        nextPageToken,
      )
    const { fetch, calls } = fakeFetch([page(200, 1, 't1'), page(200, 201, 't2'), page(200, 401, 't3')])
    const ctx = ctxWith(fetch, CREDS)

    const items = await jiraAdapter.fetch(ctx, cfg())

    expect(items).toHaveLength(500)
    expect(calls).toHaveLength(3)
  })

  it('surfaces a short, credential-free error message from a failed response', async () => {
    const { fetch } = fakeFetch([{ status: 400, json: { errorMessages: ["The JQL query is invalid."] } }])
    const ctx = ctxWith(fetch, CREDS)

    await expect(jiraAdapter.fetch(ctx, cfg())).rejects.toThrow('Jira API error: The JQL query is invalid.')
    try {
      await jiraAdapter.fetch(ctx, cfg())
    } catch (err) {
      const message = (err as Error).message
      expect(message).not.toContain('secret-token')
      expect(message).not.toContain('bot@acme.com')
    }
  })

  it('sends Basic auth built from email and apiToken', async () => {
    const { fetch, calls } = fakeFetch([issuesPage([])])
    const ctx = ctxWith(fetch, CREDS)

    await jiraAdapter.fetch(ctx, cfg())

    expect(calls[0]!.headers['Authorization']).toBe(`Basic ${b64('bot@acme.com:secret-token')}`)
  })
})

// ── adapter.write ────────────────────────────────────────────────────────────

const item = { externalId: 'ROU-1', title: 'Fix the bug', url: `${SITE}/browse/ROU-1` }

describe('jiraAdapter.write', () => {
  it('skips the transition when the issue is already in the target status', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { fields: { status: { name: 'Done' } } } }])
    const ctx = ctxWith(fetch, CREDS)

    await jiraAdapter.write(ctx, cfg(), item, { value: 'done' })

    // Only the status lookup — no transitions GET/POST, no comment.
    expect(calls).toHaveLength(1)
  })

  it('picks the transition by to.name, falling back to name', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { fields: { status: { name: 'Open' } } } },
      {
        status: 200,
        json: {
          transitions: [
            { id: '1', name: 'Start building', to: { id: 'b', name: 'Building' } },
            { id: '2', name: 'Done' }, // no `to`; falls back to its own name
          ],
        },
      },
      { status: 204, json: {} },
    ])
    const ctx = ctxWith(fetch, CREDS)

    await jiraAdapter.write(ctx, cfg(), item, { value: 'Building' })

    expect(calls).toHaveLength(3)
    expect(calls[2]!.method).toBe('POST')
    expect(calls[2]!.url).toContain('/transitions')
    expect(calls[2]!.body).toEqual({ transition: { id: '1' } })
  })

  it('falls back to the transition name when to.name is absent', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { fields: { status: { name: 'Open' } } } },
      { status: 200, json: { transitions: [{ id: '2', name: 'Done' }] } },
      { status: 204, json: {} },
    ])
    const ctx = ctxWith(fetch, CREDS)

    await jiraAdapter.write(ctx, cfg(), item, { value: 'done' })

    expect(calls[2]!.body).toEqual({ transition: { id: '2' } })
  })

  it('throws the "No transition" message when nothing matches', async () => {
    const { fetch } = fakeFetch([
      { status: 200, json: { fields: { status: { name: 'Open' } } } },
      { status: 200, json: { transitions: [{ id: '1', name: 'Close', to: { id: 'c', name: 'Closed' } }] } },
    ])
    const ctx = ctxWith(fetch, CREDS)

    await expect(jiraAdapter.write(ctx, cfg(), item, { value: 'Building' })).rejects.toThrow(
      "No transition to 'Building' from 'Open'",
    )
  })

  it('sends the comment as an ADF doc with one paragraph per line', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { fields: { status: { name: 'Done' } } } }, // already there: skip the transition
      { status: 201, json: {} }, // comment
    ])
    const ctx = ctxWith(fetch, CREDS)

    await jiraAdapter.write(ctx, cfg(), item, { value: 'done', comment: 'Line one\nLine two' })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toContain('/comment')
    expect(calls[1]!.body).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Line two' }] },
        ],
      },
    })
  })

  it('sends Basic auth on write requests too', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { fields: { status: { name: 'Done' } } } }])
    const ctx = ctxWith(fetch, CREDS)

    await jiraAdapter.write(ctx, cfg(), item, { value: 'done' })

    expect(calls[0]!.headers['Authorization']).toBe(`Basic ${b64('bot@acme.com:secret-token')}`)
  })

  it('refuses to write against a private site URL when private hosts are not allowed', async () => {
    const { fetch, calls } = fakeFetch([])
    const ctx = ctxWith(fetch, { ...CREDS, siteUrl: 'https://127.0.0.1' }, false)

    await expect(jiraAdapter.write(ctx, cfg(), item, { value: 'done' })).rejects.toThrow(
      'The Jira site URL points at a private address',
    )
    expect(calls).toHaveLength(0)
  })

  it('surfaces a short, credential-free error message from a failed transition request', async () => {
    const { fetch } = fakeFetch([
      { status: 200, json: { fields: { status: { name: 'Open' } } } },
      { status: 200, json: { transitions: [{ id: '1', name: 'Building' }] } },
      { status: 500, json: { errorMessages: ['Internal server error.'] } },
    ])
    const ctx = ctxWith(fetch, CREDS)

    await expect(jiraAdapter.write(ctx, cfg(), item, { value: 'Building' })).rejects.toThrow(
      'Jira API error: Internal server error.',
    )
  })
})
