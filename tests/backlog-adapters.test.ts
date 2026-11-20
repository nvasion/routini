/**
 * Unit tests for the backlog source adapters (server/src/backlog/*). These
 * are pure modules: no database, no real network. Every test supplies a
 * recording fake `fetch` so the adapters are exercised exactly as the
 * scheduler's sync/write ticks would call them (contract:
 * docs/work-intake-backlog.md section 6).
 */

import { describe, it, expect } from 'vitest'
import { SpecError } from '../server/src/engine/spec'
import { globToRegExp } from '../server/src/backlog/glob'
import { matchesAny, parseMapping } from '../server/src/backlog/mapping'
import { getAdapter, mondayAdapter, repoAdapter } from '../server/src/backlog/index'
import { parseMondayConfig } from '../server/src/backlog/monday'
import {
  applyStatus,
  extractState,
  extractTitle,
  parseFrontMatter,
  parseRepoConfig,
  statusBranchName,
  type RepoConfig,
} from '../server/src/backlog/repo'
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
  // Loosely typed: tests reach into provider-specific shapes (GraphQL variables,
  // GitHub REST bodies) that would otherwise need a cast at every call site.
  body: any
}

/** A fetch that answers from a fixed queue of responses, in call order, and records every call. */
function fakeFetch(responses: FakeResponse[]): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body })
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
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

// ── glob.ts ───────────────────────────────────────────────────────────────────

describe('globToRegExp', () => {
  it('matches `*` only within a single path segment', () => {
    const re = globToRegExp('*.md')
    expect(re.test('a.md')).toBe(true)
    expect(re.test('dir/a.md')).toBe(false)
  })

  it('matches `**` across any number of path segments, including none', () => {
    const re = globToRegExp('docs/**/*.md')
    expect(re.test('docs/a.md')).toBe(true)
    expect(re.test('docs/sub/a.md')).toBe(true)
    expect(re.test('docs/sub/deep/a.md')).toBe(true)
    expect(re.test('other/a.md')).toBe(false)
  })

  it('matches `?` as exactly one non-slash character', () => {
    const re = globToRegExp('a?.md')
    expect(re.test('ab.md')).toBe(true)
    expect(re.test('a.md')).toBe(false)
    expect(re.test('abc.md')).toBe(false)
  })

  it('escapes regex-special characters in the literal parts', () => {
    const re = globToRegExp('file.md')
    expect(re.test('file.md')).toBe(true)
    expect(re.test('fileXmd')).toBe(false)
  })

  it('anchors the match to the whole path', () => {
    const re = globToRegExp('*.md')
    expect(re.test('a.md.bak')).toBe(false)
    expect(re.test('xa.md')).toBe(true) // still a single segment, `*` is greedy within it
  })
})

// ── mapping.ts ────────────────────────────────────────────────────────────────

describe('matchesAny', () => {
  it('matches case-insensitive prefixes', () => {
    expect(matchesAny('Planned (2026-11-11)', ['Planned'])).toBe(true)
    expect(matchesAny('PLANNED', ['planned'])).toBe(true)
    expect(matchesAny('planned', ['PLANNED'])).toBe(true)
  })

  it('does not match a value that is merely contained, not a prefix', () => {
    expect(matchesAny('Not Planned', ['Planned'])).toBe(false)
  })

  it('returns false for an empty candidate list', () => {
    expect(matchesAny('Ready', [])).toBe(false)
  })
})

describe('parseMapping', () => {
  const validRaw = {
    out: { ready: { value: 'To do' }, done: { value: 'Done' }, blocked: { value: 'Blocked', comment: true } },
    in: { ready: ['To do'], dropped: ['Cancelled'] },
  }

  it('parses a valid mapping', () => {
    const mapping = parseMapping(validRaw)
    expect(mapping.out.done).toEqual({ value: 'Done' })
    expect(mapping.out.blocked).toEqual({ value: 'Blocked', comment: true })
    expect(mapping.in).toEqual({ ready: ['To do'], dropped: ['Cancelled'] })
  })

  it('defaults in.dropped to an empty list when omitted', () => {
    const mapping = parseMapping({ in: { ready: ['Ready'] } })
    expect(mapping.in.dropped).toEqual([])
    expect(mapping.out).toEqual({})
  })

  it('rejects a non-object mapping', () => {
    expect(() => parseMapping(null)).toThrow(SpecError)
    expect(() => parseMapping('nope')).toThrow('mapping must be an object')
  })

  it('rejects an out key that is not a valid state', () => {
    expect(() => parseMapping({ out: { bogus: { value: 'x' } }, in: { ready: ['Ready'] } })).toThrow(
      'mapping.out.bogus is not a valid state',
    )
  })

  it('rejects an out value outside 1-100 characters', () => {
    expect(() => parseMapping({ out: { done: { value: '' } }, in: { ready: ['Ready'] } })).toThrow(
      'mapping.out.done.value must be a string of 1-100 characters',
    )
    expect(() => parseMapping({ out: { done: { value: 'x'.repeat(101) } }, in: { ready: ['Ready'] } })).toThrow(
      'mapping.out.done.value must be a string of 1-100 characters',
    )
  })

  it('rejects in.ready with zero or more than 20 values', () => {
    expect(() => parseMapping({ in: { ready: [] } })).toThrow('mapping.in.ready must be a list of 1-20 strings')
    expect(() => parseMapping({ in: { ready: Array.from({ length: 21 }, (_, i) => `v${i}`) } })).toThrow(
      'mapping.in.ready must be a list of 1-20 strings',
    )
  })

  it('rejects in.dropped with more than 20 values', () => {
    expect(() =>
      parseMapping({ in: { ready: ['Ready'], dropped: Array.from({ length: 21 }, (_, i) => `v${i}`) } }),
    ).toThrow('mapping.in.dropped must be a list of 0-20 strings')
  })

  it('rejects a written value for planning/building/finishing/done/blocked that would be read back as ready (loop)', () => {
    expect(() =>
      parseMapping({ out: { blocked: { value: 'Planned' } }, in: { ready: ['Planned'] } }),
    ).toThrow("'Planned' is written for blocked and read as ready; items would loop")
  })

  it('allows the same value to be written for ready itself (no loop risk)', () => {
    expect(() => parseMapping({ out: { ready: { value: 'Planned' } }, in: { ready: ['Planned'] } })).not.toThrow()
  })
})

// ── index.ts ──────────────────────────────────────────────────────────────────

describe('getAdapter', () => {
  it('returns the monday adapter', () => {
    expect(getAdapter('monday')).toBe(mondayAdapter)
  })

  it('returns the repo adapter', () => {
    expect(getAdapter('repo')).toBe(repoAdapter)
  })
})

// ── monday.ts ─────────────────────────────────────────────────────────────────

describe('monday adapter', () => {
  const cfg = parseMondayConfig({
    boardId: '123',
    groupId: 'grp1',
    statusColumnId: 'status',
    repoColumnId: 'repo',
    labelsColumnId: 'labels',
  })

  it('parseConfig validates boardId and names the field', () => {
    expect(() => parseMondayConfig({ statusColumnId: 's' })).toThrow('config.boardId must be a string of digits')
    expect(() => parseMondayConfig({ boardId: 'not-digits', statusColumnId: 's' })).toThrow(
      'config.boardId must be a string of digits',
    )
    expect(() => parseMondayConfig({ boardId: '1' })).toThrow('config.statusColumnId must be a non-empty string')
  })

  it('fetch applies the group filter and reads status, repo and labels columns', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        json: {
          data: {
            boards: [
              {
                items_page: {
                  items: [
                    {
                      id: '1',
                      name: 'Item A',
                      url: 'https://monday.com/1',
                      group: { id: 'grp1' },
                      column_values: [
                        { id: 'status', text: 'Working on it' },
                        { id: 'repo', text: 'https://github.com/acme/app' },
                        { id: 'labels', text: 'bug, urgent' },
                      ],
                    },
                    {
                      id: '2',
                      name: 'Item B (other group)',
                      url: 'https://monday.com/2',
                      group: { id: 'grp2' },
                      column_values: [{ id: 'status', text: 'Done' }],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ])
    const ctx = ctxWith(fetch, { monday: { apiToken: 'monday-token' } })

    const items = await mondayAdapter.fetch(ctx, cfg)

    expect(items).toEqual([
      {
        externalId: '1',
        title: 'Item A',
        body: '',
        url: 'https://monday.com/1',
        state: 'Working on it',
        labels: ['bug', 'urgent'],
        repoUrl: 'https://github.com/acme/app',
      },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.monday.com/v2')
  })

  it('sends the raw apiToken as `authorization` and the fixed api-version header', async () => {
    let seenHeaders: Record<string, string> | undefined
    const fetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>
      return { status: 200, ok: true, json: async () => ({ data: { boards: [] } }) } as unknown as Response
    }) as FetchFn
    const ctx = ctxWith(fetch, { monday: { apiToken: 'secret-token' } })

    await mondayAdapter.fetch(ctx, cfg)

    expect(seenHeaders?.authorization).toBe('secret-token')
    expect(seenHeaders?.['api-version']).toBe('2024-10')
  })

  it('write sends only the status mutation when there is no comment', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { data: { change_simple_column_value: { id: '1' } } } }])
    const ctx = ctxWith(fetch, { monday: { apiToken: 't' } })

    await mondayAdapter.write(ctx, cfg, { externalId: '1', title: 'Item A', url: null }, { value: 'Done' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.variables).toEqual({ boardId: '123', itemId: '1', columnId: 'status', value: 'Done' })
  })

  it('write also posts a comment update when one is given', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, json: { data: { change_simple_column_value: { id: '1' } } } },
      { status: 200, json: { data: { create_update: { id: '9' } } } },
    ])
    const ctx = ctxWith(fetch, { monday: { apiToken: 't' } })

    await mondayAdapter.write(ctx, cfg, { externalId: '1', title: 'Item A', url: null }, { value: 'Done', comment: 'All set' })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.variables).toEqual({ itemId: '1', body: 'All set' })
  })

  it('surfaces the first GraphQL error on fetch', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { errors: [{ message: 'Board not found' }, { message: 'second' }] } }])
    const ctx = ctxWith(fetch, { monday: { apiToken: 't' } })

    await expect(mondayAdapter.fetch(ctx, cfg)).rejects.toThrow('Board not found')
  })

  it('surfaces the first GraphQL error on write', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { errors: [{ message: 'Invalid column' }] } }])
    const ctx = ctxWith(fetch, { monday: { apiToken: 't' } })

    await expect(
      mondayAdapter.write(ctx, cfg, { externalId: '1', title: 'A', url: null }, { value: 'Done' }),
    ).rejects.toThrow('Invalid column')
  })
})

// ── repo.ts: config ───────────────────────────────────────────────────────────

describe('repo adapter parseConfig', () => {
  const base = { glob: '**/*.md', status: { kind: 'frontmatter', key: 'status' } }

  it('rejects a repoUrl that is not a github.com URL', () => {
    expect(() => parseRepoConfig({ ...base, repoUrl: 'https://gitlab.com/acme/app' })).toThrow(
      'repoUrl must be a https://github.com/<owner>/<repo> URL',
    )
  })

  it('defaults branch to main and derives owner/repo', () => {
    const cfg = parseRepoConfig({ ...base, repoUrl: 'https://github.com/acme/app' })
    expect(cfg.owner).toBe('acme')
    expect(cfg.repo).toBe('app')
    expect(cfg.branch).toBe('main')
  })

  it('rejects a branch containing ..', () => {
    expect(() => parseRepoConfig({ ...base, repoUrl: 'https://github.com/acme/app', branch: 'feature/../evil' })).toThrow(
      'branch must not contain ..',
    )
  })

  it('rejects a glob containing ..', () => {
    expect(() => parseRepoConfig({ ...base, repoUrl: 'https://github.com/acme/app', glob: '../*.md' })).toThrow(
      'glob must not contain ..',
    )
  })

  it('rejects an unknown status.kind', () => {
    expect(() =>
      parseRepoConfig({ repoUrl: 'https://github.com/acme/app', glob: '*.md', status: { kind: 'nope' } }),
    ).toThrow('config.status.kind must be "frontmatter" or "line"')
  })

  it('accepts a line status config and an optional repoKey', () => {
    const cfg = parseRepoConfig({
      repoUrl: 'https://github.com/acme/app',
      glob: '*.md',
      status: { kind: 'line', prefix: 'STATUS:' },
      repoKey: 'repo',
    })
    expect(cfg.status).toEqual({ kind: 'line', prefix: 'STATUS:' })
    expect(cfg.repoKey).toBe('repo')
  })
})

// ── repo.ts: pure text helpers ────────────────────────────────────────────────

describe('repo adapter front matter / title / state helpers', () => {
  it('reads front matter title and state, falling back through heading then file name', () => {
    const withTitle = 'docs/a.md'
    const linesA = ['---', 'title: "Alpha"', 'status: Building', '---', 'Body.'].join('\n').split('\n')
    const fmA = parseFrontMatter(linesA)
    expect(extractTitle(withTitle, linesA, fmA)).toBe('Alpha')
    expect(extractState(linesA, fmA, { kind: 'frontmatter', key: 'status' })).toBe('Building')

    const linesB = ['# Beta Heading', 'Some content', 'STATUS: Blocked'].join('\n').split('\n')
    const fmB = parseFrontMatter(linesB)
    expect(extractTitle('docs/b.md', linesB, fmB)).toBe('Beta Heading')
    expect(extractState(linesB, fmB, { kind: 'line', prefix: 'STATUS:' })).toBe('Blocked')

    const linesC = ['Just a line.'].join('\n').split('\n')
    const fmC = parseFrontMatter(linesC)
    expect(extractTitle('docs/plain-file.md', linesC, fmC)).toBe('plain-file.md')
    expect(extractState(linesC, fmC, { kind: 'line', prefix: 'STATUS:' })).toBe('')
  })

  it('reads a repoKey value from front matter', () => {
    const lines = ['---', 'title: "Fix it"', 'repo: https://github.com/acme/work', '---', 'Body.'].join('\n').split('\n')
    const fm = parseFrontMatter(lines)
    expect(fm.data.repo).toBe('https://github.com/acme/work')
  })
})

describe('repo adapter applyStatus', () => {
  it('changes only the front matter status field, leaving the rest untouched', () => {
    const text = ['---', 'title: "Fix bug"', 'status: Planning', '---', 'Do the work.'].join('\n')
    const updated = applyStatus(text, { kind: 'frontmatter', key: 'status' }, 'Building')
    expect(updated).toBe(['---', 'title: "Fix bug"', 'status: Building', '---', 'Do the work.'].join('\n'))
  })

  it('inserts the front matter key when it was missing', () => {
    const text = ['---', 'title: "No status yet"', '---', 'Content.'].join('\n')
    const updated = applyStatus(text, { kind: 'frontmatter', key: 'status' }, 'Blocked')
    expect(updated).toBe(['---', 'title: "No status yet"', 'status: Blocked', '---', 'Content.'].join('\n'))
  })

  it('replaces the first line starting with the prefix for line-kind status', () => {
    const text = ['# Title', 'STATUS: Planning', 'More text.'].join('\n')
    const updated = applyStatus(text, { kind: 'line', prefix: 'STATUS:' }, 'Building')
    expect(updated).toBe(['# Title', 'STATUS: Building', 'More text.'].join('\n'))
  })
})

describe('statusBranchName', () => {
  it('lowercases and replaces non-alphanumerics, capped at 80 characters', () => {
    expect(statusBranchName('docs/Fix Bug.md')).toBe('routini/status/docs-fix-bug-md')
  })

  it('caps the slug at 80 characters', () => {
    const long = 'a'.repeat(200) + '.md'
    const branch = statusBranchName(long)
    expect(branch.startsWith('routini/status/')).toBe(true)
    expect(branch.length).toBeLessThanOrEqual('routini/status/'.length + 80)
  })
})

// ── repo.ts: fetch ────────────────────────────────────────────────────────────

function treeResponse(paths: string[]): FakeResponse {
  return { status: 200, json: { tree: paths.map((path) => ({ path, type: 'blob', sha: `sha-${path}` })) } }
}

function contentsResponse(text: string, sha = 'file-sha'): FakeResponse {
  return { status: 200, json: { content: b64(text), sha, encoding: 'base64' } }
}

describe('repo adapter fetch', () => {
  const repoCfg = (overrides: Partial<RepoConfig> = {}): RepoConfig =>
    parseRepoConfig({
      repoUrl: 'https://github.com/acme/app',
      glob: 'docs/**/*.md',
      status: { kind: 'frontmatter', key: 'status' },
      ...overrides,
    })

  it('filters files by glob, including ** and *', async () => {
    const paths = ['docs/a.md', 'docs/sub/b.md', 'docs/sub/deep/c.md', 'README.md', 'docs/notes.txt']
    const { fetch, calls } = fakeFetch([
      treeResponse(paths),
      contentsResponse('---\nstatus: Ready\n---\nA'),
      contentsResponse('---\nstatus: Ready\n---\nB'),
      contentsResponse('---\nstatus: Ready\n---\nC'),
    ])
    const ctx = ctxWith(fetch, { github: { token: 'gh' } })

    const items = await repoAdapter.fetch(ctx, repoCfg())

    expect(items.map((i) => i.externalId)).toEqual(['docs/a.md', 'docs/sub/b.md', 'docs/sub/deep/c.md'])
    // One tree call plus one contents call per matched file.
    expect(calls).toHaveLength(1 + 3)
  })

  it('fails with the 200-file limit message when too many files match', async () => {
    const paths = Array.from({ length: 201 }, (_, i) => `docs/file-${i}.md`)
    const { fetch } = fakeFetch([treeResponse(paths)])
    const ctx = ctxWith(fetch, { github: { token: 'gh' } })

    await expect(repoAdapter.fetch(ctx, repoCfg())).rejects.toThrow(
      'Narrow the glob: 201 files match, the limit is 200',
    )
  })

  it('reports the repoKey value from front matter', async () => {
    const { fetch } = fakeFetch([
      treeResponse(['docs/a.md']),
      contentsResponse(['---', 'status: Ready', 'repo: https://github.com/acme/work', '---', 'Body'].join('\n')),
    ])
    const ctx = ctxWith(fetch, { github: { token: 'gh' } })

    const items = await repoAdapter.fetch(ctx, repoCfg({ repoKey: 'repo' }))

    expect(items[0]!.repoUrl).toBe('https://github.com/acme/work')
  })

  it('is null for repoUrl when repoKey is not configured', async () => {
    const { fetch } = fakeFetch([
      treeResponse(['docs/a.md']),
      contentsResponse(['---', 'status: Ready', 'repo: https://github.com/acme/work', '---', 'Body'].join('\n')),
    ])
    const ctx = ctxWith(fetch, { github: { token: 'gh' } })

    const items = await repoAdapter.fetch(ctx, repoCfg())

    expect(items[0]!.repoUrl).toBeNull()
  })

  it('reads the GitHub token from ctx.credentials and uses the fixed host', async () => {
    let seenUrl = ''
    let seenAuth: string | undefined
    const fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url
      seenAuth = (init?.headers as Record<string, string>)?.Authorization
      return { status: 200, ok: true, json: async () => ({ tree: [] }) } as unknown as Response
    }) as FetchFn
    const ctx = ctxWith(fetch, { github: { token: 'gh-secret' } })

    await repoAdapter.fetch(ctx, repoCfg())

    expect(seenUrl.startsWith('https://api.github.com/')).toBe(true)
    expect(seenAuth).toBe('Bearer gh-secret')
  })
})

// ── repo.ts: write ────────────────────────────────────────────────────────────

describe('repo adapter write', () => {
  const repoCfg = parseRepoConfig({
    repoUrl: 'https://github.com/acme/app',
    glob: 'docs/**/*.md',
    status: { kind: 'frontmatter', key: 'status' },
  })
  const path = 'docs/fix-bug.md'
  const branch = statusBranchName(path)
  const item = { externalId: path, title: 'Fix bug', url: null }

  it('first write creates the status branch, PUTs only the status field and opens one PR', async () => {
    const originalText = ['---', 'title: "Fix bug"', 'status: Planning', '---', 'Do the work.'].join('\n')
    const { fetch, calls } = fakeFetch([
      { status: 200, json: [] }, // no open PR
      { status: 404, json: { message: 'Not Found' } }, // status branch does not exist
      { status: 200, json: { object: { sha: 'base-sha' } } }, // tracking branch head
      { status: 201, json: { ref: `refs/heads/${branch}`, object: { sha: 'base-sha' } } }, // create branch
      contentsResponse(originalText, 'file-sha-1'), // read file on status branch
      { status: 200, json: { content: { sha: 'file-sha-2' } } }, // PUT file
      { status: 201, json: { html_url: 'https://github.com/acme/app/pull/1', number: 1 } }, // open PR
    ])
    const ctx = ctxWith(fetch, { github: { token: 'gh' } })

    await repoAdapter.write(ctx, repoCfg, item, { value: 'Building' })

    expect(calls).toHaveLength(7)

    const createRefCall = calls[3]!
    expect(createRefCall.method).toBe('POST')
    expect(createRefCall.url).toContain('/git/refs')
    expect(createRefCall.body).toEqual({ ref: `refs/heads/${branch}`, sha: 'base-sha' })

    const putCall = calls[5]!
    expect(putCall.method).toBe('PUT')
    expect(putCall.url).toContain(`/contents/docs/fix-bug.md`)
    expect(putCall.body.branch).toBe(branch)
    expect(putCall.body.branch).not.toBe('main') // never writes to the tracking branch
    expect(putCall.body.sha).toBe('file-sha-1')
    const putText = Buffer.from(putCall.body.content, 'base64').toString('utf8')
    expect(putText).toBe(['---', 'title: "Fix bug"', 'status: Building', '---', 'Do the work.'].join('\n'))

    const prCall = calls[6]!
    expect(prCall.method).toBe('POST')
    expect(prCall.url).toContain('/pulls')
    expect(prCall.body.head).toBe(branch)
    expect(prCall.body.base).toBe('main')
    expect(prCall.body.title).toBe('Routini: Fix bug -> Building')
  })

  it('second write finds the open PR, updates the file and opens no new PR', async () => {
    const currentText = ['---', 'title: "Fix bug"', 'status: Building', '---', 'Do the work.'].join('\n')
    const { fetch, calls } = fakeFetch([
      { status: 200, json: [{ number: 1, html_url: 'https://github.com/acme/app/pull/1' }] }, // PR already open
      contentsResponse(currentText, 'file-sha-2'), // read file on status branch
      { status: 200, json: { content: { sha: 'file-sha-3' } } }, // PUT file
    ])
    const ctx = ctxWith(fetch, { github: { token: 'gh' } })

    await repoAdapter.write(ctx, repoCfg, item, { value: 'Finishing' })

    // No ref lookups, no branch creation, no new PR: list PR, read file, PUT file.
    expect(calls).toHaveLength(3)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/pulls'))).toBe(false)
    expect(calls.some((c) => c.url.includes('/git/refs'))).toBe(false)

    const putCall = calls[2]!
    expect(putCall.body.branch).toBe(branch)
    const putText = Buffer.from(putCall.body.content, 'base64').toString('utf8')
    expect(putText).toBe(['---', 'title: "Fix bug"', 'status: Finishing', '---', 'Do the work.'].join('\n'))
  })

  it('reuses an existing status branch (no PR yet) instead of creating a new one', async () => {
    const currentText = ['---', 'title: "Fix bug"', 'status: Planning', '---', 'Do the work.'].join('\n')
    const { fetch, calls } = fakeFetch([
      { status: 200, json: [] }, // no open PR
      { status: 200, json: { object: { sha: 'existing-sha' } } }, // status branch already exists
      contentsResponse(currentText, 'file-sha-1'),
      { status: 200, json: { content: { sha: 'file-sha-2' } } },
      { status: 201, json: { html_url: 'https://github.com/acme/app/pull/2', number: 2 } },
    ])
    const ctx = ctxWith(fetch, { github: { token: 'gh' } })

    await repoAdapter.write(ctx, repoCfg, item, { value: 'Building' })

    // Only one ref lookup (the status branch) — the tracking branch's head is never fetched.
    expect(calls.filter((c) => c.url.includes('/git/ref/heads/'))).toHaveLength(1)
    expect(calls.some((c) => c.url.includes('/git/refs') && c.method === 'POST')).toBe(false)
  })
})
