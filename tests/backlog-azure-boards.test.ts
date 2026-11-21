/**
 * Unit tests for the Azure Boards backlog source adapter
 * (server/src/backlog/azureBoards.ts). Pure module: no database, no real
 * network. Every test supplies a recording fake `fetch` so the adapter is
 * exercised exactly as the scheduler's sync/write ticks would call it
 * (contract: docs/work-intake-backlog.md section 6b).
 */

import { describe, it, expect } from 'vitest'
import { SpecError } from '../server/src/engine/spec'
import { azureBoardsAdapter, parseAzureBoardsConfig, stripHtml } from '../server/src/backlog/azureBoards'
import type { AdapterCtx } from '../server/src/backlog/types'
import type { FetchFn } from '../server/src/integrations/providers'

// ── Fake fetch ────────────────────────────────────────────────────────────────

interface FakeResponse {
  status: number
  /** JSON body. Omit (undefined) to send an HTML sign-in page instead. */
  json?: unknown
  html?: string
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
    const text = r.html !== undefined ? r.html : r.json !== undefined ? JSON.stringify(r.json) : ''
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response
  }) as FetchFn
  return { fetch, calls }
}

function ctxWith(fetch: FetchFn, creds: Record<string, string>): AdapterCtx {
  return {
    fetch,
    credentials: async () => creds,
    allowPrivateHosts: false,
  }
}

const CREDS = { organization: 'acme', pat: 'secret-pat' }

function workItemsBatch(items: Array<{ id: number; fields: Record<string, unknown> }>): FakeResponse {
  return { status: 200, json: { value: items } }
}

// ── parseConfig ────────────────────────────────────────────────────────────────

describe('parseAzureBoardsConfig', () => {
  it('requires config to be an object', () => {
    expect(() => parseAzureBoardsConfig(null)).toThrow(SpecError)
    expect(() => parseAzureBoardsConfig('nope')).toThrow('config must be an object')
  })

  it('requires project and names the field', () => {
    expect(() => parseAzureBoardsConfig({})).toThrow('config.project must be a string')
    expect(() => parseAzureBoardsConfig({ project: '' })).toThrow('config.project must not be empty')
    expect(() => parseAzureBoardsConfig({ project: 'x'.repeat(65) })).toThrow('config.project must be at most 64 characters')
  })

  it('rejects a project name with characters ADO forbids', () => {
    expect(() => parseAzureBoardsConfig({ project: 'bad/name' })).toThrow('config.project is not a valid Azure DevOps project name')
    expect(() => parseAzureBoardsConfig({ project: '.leading-dot' })).toThrow('config.project is not a valid Azure DevOps project name')
  })

  it('accepts a bare project and leaves wiql/repoField unset', () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    expect(cfg).toEqual({ project: 'Contoso' })
  })

  it('validates an optional wiql', () => {
    expect(() => parseAzureBoardsConfig({ project: 'P', wiql: '' })).toThrow('config.wiql must not be empty')
    expect(() => parseAzureBoardsConfig({ project: 'P', wiql: 'x'.repeat(2001) })).toThrow(
      'config.wiql must be at most 2000 characters',
    )
    const cfg = parseAzureBoardsConfig({ project: 'P', wiql: 'SELECT [System.Id] FROM WorkItems' })
    expect(cfg.wiql).toBe('SELECT [System.Id] FROM WorkItems')
  })

  it('validates an optional repoField', () => {
    expect(() => parseAzureBoardsConfig({ project: 'P', repoField: '' })).toThrow('config.repoField must be a non-empty string')
    const cfg = parseAzureBoardsConfig({ project: 'P', repoField: 'Custom.Repository' })
    expect(cfg.repoField).toBe('Custom.Repository')
  })
})

// ── stripHtml ─────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes tags and decodes common entities', () => {
    expect(stripHtml('<div>Hello&nbsp;<b>world</b> &amp; friends</div>')).toBe('Hello world & friends')
  })

  it('collapses surrounding whitespace left by stripped tags', () => {
    expect(stripHtml('<p>Line one</p><p>Line two</p>')).toBe('Line one\nLine two')
    expect(stripHtml('a<br>b<br/>  <div> c </div>')).toBe('a\nb\nc')
    expect(stripHtml('&amp;lt;')).toBe('&lt;')
  })
})

// ── fetch ─────────────────────────────────────────────────────────────────────

describe('azureBoardsAdapter.fetch', () => {
  it('uses the default WIQL (not in Closed/Done/Removed) when none is configured', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { workItems: [{ id: 1 }] } },
      workItemsBatch([{ id: 1, fields: { 'System.Title': 'A', 'System.State': 'To Do', 'System.Tags': '' } }]),
    ])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.fetch(ctx, cfg)

    expect(calls[0]!.body.query).toContain('NOT IN')
    expect(calls[0]!.url).toContain('/acme/Contoso/_apis/wit/wiql')
    expect(calls[0]!.url).toContain('$top=500')
  })

  it('sends a custom wiql verbatim', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso', wiql: 'SELECT [System.Id] FROM WorkItems WHERE [System.State] = \'Active\'' })
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { workItems: [] } },
    ])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.fetch(ctx, cfg)

    expect(calls[0]!.body.query).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'")
  })

  it('batches workitemsbatch in chunks of 200 when WIQL returns more', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    const ids = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }))
    const batch1 = ids.slice(0, 200).map((w) => ({ id: w.id, fields: { 'System.Title': `Item ${w.id}`, 'System.State': 'To Do' } }))
    const batch2 = ids.slice(200).map((w) => ({ id: w.id, fields: { 'System.Title': `Item ${w.id}`, 'System.State': 'To Do' } }))
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { workItems: ids } },
      workItemsBatch(batch1),
      workItemsBatch(batch2),
    ])
    const ctx = ctxWith(fetch, CREDS)

    const items = await azureBoardsAdapter.fetch(ctx, cfg)

    // One WIQL call, then two workitemsbatch calls (200 + 50).
    expect(calls).toHaveLength(3)
    expect(calls[1]!.body.ids).toHaveLength(200)
    expect(calls[2]!.body.ids).toHaveLength(50)
    expect(items).toHaveLength(250)
  })

  it('caps results at 500 even when WIQL returns more', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    const ids = Array.from({ length: 600 }, (_, i) => ({ id: i + 1 }))
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { workItems: ids } },
      workItemsBatch(Array.from({ length: 200 }, (_, i) => ({ id: i + 1, fields: { 'System.Title': 't', 'System.State': 's' } }))),
      workItemsBatch(Array.from({ length: 200 }, (_, i) => ({ id: i + 201, fields: { 'System.Title': 't', 'System.State': 's' } }))),
      workItemsBatch(Array.from({ length: 100 }, (_, i) => ({ id: i + 401, fields: { 'System.Title': 't', 'System.State': 's' } }))),
    ])
    const ctx = ctxWith(fetch, CREDS)

    const items = await azureBoardsAdapter.fetch(ctx, cfg)

    expect(items).toHaveLength(500)
    // 1 WIQL + 3 batch calls (200 + 200 + 100 = 500)
    expect(calls).toHaveLength(4)
  })

  it('maps fields including tags, strips description HTML, and reads the repoField', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso', repoField: 'Custom.Repository' })
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { workItems: [{ id: 42 }] } },
      workItemsBatch([
        {
          id: 42,
          fields: {
            'System.Title': 'Fix the thing',
            'System.Description': '<div>Steps:<br/>1. Do it</div>',
            'System.State': 'Active',
            'System.Tags': 'bug; urgent ; needs-triage',
            'Custom.Repository': 'https://github.com/acme/app',
          },
        },
      ]),
    ])
    const ctx = ctxWith(fetch, CREDS)

    const items = await azureBoardsAdapter.fetch(ctx, cfg)

    expect(items).toEqual([
      {
        externalId: '42',
        title: 'Fix the thing',
        body: 'Steps:\n1. Do it',
        url: 'https://dev.azure.com/acme/Contoso/_workitems/edit/42',
        state: 'Active',
        labels: ['bug', 'urgent', 'needs-triage'],
        repoUrl: 'https://github.com/acme/app',
        position: 0,
      },
    ])
    expect(calls[1]!.body.fields).toContain('Custom.Repository')
  })

  it('sends Basic auth built from the PAT with an empty username', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    const { fetch, calls } = fakeFetch([{ status: 200, json: { workItems: [] } }])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.fetch(ctx, cfg)

    const expected = 'Basic ' + Buffer.from(':secret-pat', 'utf8').toString('base64')
    expect(calls[0]!.headers.Authorization).toBe(expected)
  })

  it('treats an HTML sign-in page returned with a 2xx status as a clear error', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    const { fetch } = fakeFetch([{ status: 200, html: '<html><body>Sign in to continue</body></html>' }])
    const ctx = ctxWith(fetch, CREDS)

    await expect(azureBoardsAdapter.fetch(ctx, cfg)).rejects.toThrow(
      'Azure DevOps did not accept the token (sign-in page returned)',
    )
  })

  it('treats a 203 status as the sign-in page signal', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    const { fetch } = fakeFetch([{ status: 203, html: '<html>sign in</html>' }])
    const ctx = ctxWith(fetch, CREDS)

    await expect(azureBoardsAdapter.fetch(ctx, cfg)).rejects.toThrow(
      'Azure DevOps did not accept the token (sign-in page returned)',
    )
  })

  it('surfaces a tracker error body as a short message without leaking credentials', async () => {
    const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
    const { fetch } = fakeFetch([{ status: 404, json: { message: 'TF200016: The following project does not exist' } }])
    const ctx = ctxWith(fetch, CREDS)

    let message = ''
    try {
      await azureBoardsAdapter.fetch(ctx, cfg)
      throw new Error('expected fetch to reject')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toBe('Azure DevOps request failed (HTTP 404): TF200016: The following project does not exist')
    expect(message).not.toContain('secret-pat')
  })
})

// ── write ─────────────────────────────────────────────────────────────────────

describe('azureBoardsAdapter.write', () => {
  const cfg = parseAzureBoardsConfig({ project: 'Contoso' })
  const item = { externalId: '42', title: 'Fix the thing', url: null }

  it('PATCHes a JSON-patch document setting System.State, with the right content type', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { id: 42, fields: { 'System.State': 'Done' } } }])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.write(ctx, cfg, item, { value: 'Done' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url).toBe('https://dev.azure.com/acme/_apis/wit/workitems/42?api-version=7.1')
    expect(calls[0]!.headers['Content-Type']).toBe('application/json-patch+json')
    expect(calls[0]!.body).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Done' }])
  })

  it('also posts a comment through the comments API when one is given', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { id: 42, fields: { 'System.State': 'Done' } } },
      { status: 200, json: { id: 1, text: 'All set' } },
    ])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.write(ctx, cfg, item, { value: 'Done', comment: 'All set' })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.method).toBe('POST')
    expect(calls[1]!.url).toBe('https://dev.azure.com/acme/Contoso/_apis/wit/workItems/42/comments?api-version=7.1-preview.4')
    expect(calls[1]!.body).toEqual({ text: 'All set' })
  })

  it('escapes the comment as HTML and keeps its line breaks', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { id: 42 } },
      { status: 200, json: { id: 1 } },
    ])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.write(ctx, cfg, item, { value: 'Done', comment: 'PR opened: <link>\nA & B' })

    expect(calls[1]!.body).toEqual({ text: 'PR opened: &lt;link&gt;<br>A &amp; B' })
  })

  it('sends no comment call when none is given', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { id: 42 } }])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.write(ctx, cfg, item, { value: 'Active' })

    expect(calls).toHaveLength(1)
  })

  it('sends Basic auth built from the PAT', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { id: 42 } }])
    const ctx = ctxWith(fetch, CREDS)

    await azureBoardsAdapter.write(ctx, cfg, item, { value: 'Active' })

    const expected = 'Basic ' + Buffer.from(':secret-pat', 'utf8').toString('base64')
    expect(calls[0]!.headers.Authorization).toBe(expected)
  })
})
