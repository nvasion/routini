// Live run streams (SSE) with Last-Event-ID resume, and secret redaction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { redact, redactDeep } from '../server/src/utils/redact'
import type { FetchFn } from '../server/src/services/http'

const okFetch: FetchFn = async () => new Response('ok', { status: 200 })

interface SseEvent {
  id?: number
  event: string
  data: unknown
}

/** Reads an SSE response until `end` arrives (or the stream closes). */
async function readSse(url: string, headers: Record<string, string>): Promise<SseEvent[]> {
  const res = await fetch(url, { headers })
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const ev: Partial<SseEvent> = {}
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) ev.id = Number(line.slice(4))
        if (line.startsWith('event: ')) ev.event = line.slice(7)
        if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6))
      }
      if (ev.event) events.push(ev as SseEvent)
    }
    if (events.some((e) => e.event === 'end')) break
  }
  await reader.cancel().catch(() => {})
  return events
}

describe('run streams', () => {
  let t: TestApp
  let u: TestUser
  let server: Server
  let origin: string
  let worker: Worker

  beforeEach(async () => {
    t = await makeTestApp({ engine: { actions: { http: { fetchImpl: okFetch, ssrfCheck: async () => true } } } })
    u = await t.signup('sse@example.com')
    server = t.app.listen(0)
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 })
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
    await t.close()
  })

  async function finishedRun() {
    const job = await u.post(`/api/orgs/${u.orgSlug}/jobs`, {
      name: 'stream me',
      steps: [
        { name: 'a', kind: 'action', config: { type: 'http', url: 'https://example.test/a' } },
        { name: 'b', kind: 'action', config: { type: 'http', url: 'https://example.test/b' } },
      ],
    })
    const run = (await u.post(`/api/orgs/${u.orgSlug}/jobs/${job.body.job.id}/run`)).body.run
    return run as { id: string; number: number }
  }

  it('streams events live while the run executes, then ends', async () => {
    const run = await finishedRun()
    const reading = readSse(`${origin}/api/orgs/${u.orgSlug}/runs/${run.number}/stream`, { Authorization: `Bearer ${u.token}` })
    await new Promise((r) => setTimeout(r, 100)) // subscribed before the work happens
    await worker.drain()
    const events = await reading
    expect(events.at(-1)).toEqual({ event: 'end', data: { status: 'succeeded' } })
    const ids = events.filter((e) => e.id !== undefined).map((e) => e.id!)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(events.filter((e) => e.event === 'status').map((e) => (e.data as { data: { status: string } }).data.status)).toEqual(['queued', 'running', 'succeeded'])
  })

  it('resumes after Last-Event-ID without repeating or losing events', async () => {
    const run = await finishedRun()
    await worker.drain()
    const all = (await u.get(`/api/orgs/${u.orgSlug}/runs/${run.id}/events`)).body.events as Array<{ id: number }>
    const cut = all[Math.floor(all.length / 2)]!.id
    const resumed = await readSse(`${origin}/api/orgs/${u.orgSlug}/runs/${run.id}/stream`, {
      Authorization: `Bearer ${u.token}`,
      'Last-Event-ID': String(cut),
    })
    const got = resumed.filter((e) => e.id !== undefined).map((e) => e.id)
    expect(got).toEqual(all.filter((e) => e.id > cut).map((e) => e.id))
  })

  it('refuses streams of other orgs', async () => {
    const run = await finishedRun()
    const other = await t.signup('other-sse@example.com')
    const res = await fetch(`${origin}/api/orgs/${u.orgSlug}/runs/${run.id}/stream`, { headers: { Authorization: `Bearer ${other.token}` } })
    expect(res.status).toBe(404)
  })
})

describe('redact', () => {
  it('removes exact known secrets, including each line of a multi-line key', () => {
    const key = '-----BEGIN KEY-----\nAAAAsecretline1\nBBBBsecretline2\n-----END KEY-----'
    expect(redact('token is hunter2-long-value ok', ['hunter2-long-value'])).toBe('token is [REDACTED] ok')
    expect(redact('got BBBBsecretline2 back', [key])).toBe('got [REDACTED] back')
    expect(redact('-----BEGIN KEY-----', [key])).toBe('-----BEGIN KEY-----')
  })

  it('ignores very short secrets to avoid mangling ordinary output', () => {
    expect(redact('the cat sat', ['cat'])).toBe('the cat sat')
  })

  it('catches common token shapes it was never told about', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]')
    expect(redact('key sk-ant-api03-abcdefghijkl')).toBe('key [REDACTED]')
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe('[REDACTED]')
    expect(redact('postgres://app:pa55word@db:5432/x')).toBe('postgres://app:[REDACTED]@db:5432/x')
    expect(redact('password=letmein now')).toBe('password=[REDACTED] now')
  })

  it('redacts nested values', () => {
    expect(redactDeep({ a: ['secret-value-1'], b: { c: 'x secret-value-1 y' }, n: 3 }, ['secret-value-1'])).toEqual({
      a: ['[REDACTED]'],
      b: { c: 'x [REDACTED] y' },
      n: 3,
    })
  })
})
