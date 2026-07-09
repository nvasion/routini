/**
 * Tests for the HTTP dashboard handler.
 *
 * The global `fetch` and DNS lookup are both injected so no network calls
 * happen. Coverage:
 *   - Input validation (missing URL, invalid scheme)
 *   - SSRF blocking via DNS-pin (public → private rebind)
 *   - Successful GET returns status, body, headers
 *   - Body truncation at maxBodyBytes
 *   - Sensitive response headers stripped
 *   - Redirect following with re-validation at each hop
 *   - Redirect to an SSRF-unsafe host is blocked
 *   - Timeout aborts a slow request
 */

import { describe, expect, it, vi } from 'vitest'
import { fetchDashboard } from '../server/src/tasks/daily/dashboardHandler.js'
import type {
  DashboardFetchOptions,
} from '../server/src/tasks/daily/dashboardHandler.js'
import type { LookupFn } from '../server/src/tasks/daily/dns.js'

/** Public-IP lookup used by most tests. */
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }]

/** Loopback lookup used for the DNS-rebind scenarios. */
const loopbackLookup: LookupFn = async () => [{ address: '127.0.0.1', family: 4 }]

/**
 * Build a `fetch` stub that answers URL-by-URL. Consumers pass a map of
 * `{ url: Response | (url) => Response }`.
 */
function fetchStub(
  answers: Record<string, Response | ((url: string) => Response)>,
): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const answer = answers[url]
    if (!answer) throw new Error(`unexpected fetch call: ${url}`)
    return typeof answer === 'function' ? answer(url) : answer
  }) as typeof fetch
}

function baseOptions(fetchImpl: typeof fetch, lookup: LookupFn = publicLookup): DashboardFetchOptions {
  return {
    fetchImpl,
    lookup,
    timeoutMs: 5000,
  }
}

describe('fetchDashboard — validation', () => {
  it('rejects a missing url', async () => {
    await expect(
      fetchDashboard({ url: '' }, baseOptions(fetchStub({}))),
    ).rejects.toThrow(/url is required/)
  })

  it('rejects a non-http scheme', async () => {
    await expect(
      fetchDashboard({ url: 'file:///etc/passwd' }, baseOptions(fetchStub({}))),
    ).rejects.toThrow(/http/)
  })

  it('rejects a localhost URL at input validation time (no DNS)', async () => {
    let lookupCalled = false
    const lookup: LookupFn = async () => {
      lookupCalled = true
      return []
    }
    await expect(
      fetchDashboard(
        { url: 'http://localhost/dashboard' },
        { fetchImpl: fetchStub({}), lookup },
      ),
    ).rejects.toThrow(/disallowed/)
    expect(lookupCalled).toBe(false)
  })
})

describe('fetchDashboard — DNS pin SSRF guard', () => {
  it('rejects when the hostname now resolves to loopback (DNS rebind)', async () => {
    let fetchCalled = false
    const fetchImpl = fetchStub({
      'https://rebind.example/api': new Response('should never reach here'),
    })
    const wrapped: typeof fetch = ((...args) => {
      fetchCalled = true
      return fetchImpl(...args)
    }) as typeof fetch
    await expect(
      fetchDashboard(
        { url: 'https://rebind.example/api' },
        baseOptions(wrapped, loopbackLookup),
      ),
    ).rejects.toThrow(/disallowed/)
    expect(fetchCalled).toBe(false)
  })
})

describe('fetchDashboard — successful requests', () => {
  it('returns status, statusText and body on a plain 200', async () => {
    const response = new Response('{"ok": true}', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    })
    const result = await fetchDashboard(
      { url: 'https://example.com/status' },
      baseOptions(fetchStub({ 'https://example.com/status': response })),
    )
    expect(result.status).toBe(200)
    expect(result.statusText).toBe('OK')
    expect(result.body).toBe('{"ok": true}')
    expect(result.bodyTruncated).toBe(false)
    expect(result.headers['content-type']).toBe('application/json')
  })

  it('truncates the body at maxBodyBytes and flags truncation', async () => {
    const bigBody = 'A'.repeat(2000)
    const result = await fetchDashboard(
      { url: 'https://example.com/big' },
      {
        ...baseOptions(
          fetchStub({
            'https://example.com/big': new Response(bigBody),
          }),
        ),
        maxBodyBytes: 128,
      },
    )
    expect(result.body.length).toBe(128)
    expect(result.bodyTruncated).toBe(true)
  })

  it('strips Set-Cookie and WWW-Authenticate from the returned headers', async () => {
    const response = new Response('body', {
      status: 200,
      headers: {
        'set-cookie': 'session=zzz',
        'www-authenticate': 'Basic realm=x',
        'x-safe': 'yes',
      },
    })
    const result = await fetchDashboard(
      { url: 'https://example.com/ok' },
      baseOptions(fetchStub({ 'https://example.com/ok': response })),
    )
    // `Response` auto-adds content-type; we only care that sensitive
    // headers are absent and that non-sensitive ones make it through.
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers['www-authenticate']).toBeUndefined()
    expect(result.headers['x-safe']).toBe('yes')
  })
})

describe('fetchDashboard — redirects', () => {
  it('follows a 302 to another public host and re-validates it', async () => {
    const answers: Record<string, Response> = {
      'https://a.example/x': new Response(null, {
        status: 302,
        headers: { location: 'https://b.example/y' },
      }),
      'https://b.example/y': new Response('final'),
    }
    const lookupHits: string[] = []
    const lookup: LookupFn = async () => {
      lookupHits.push('lookup')
      return [{ address: '93.184.216.34', family: 4 }]
    }
    const result = await fetchDashboard(
      { url: 'https://a.example/x' },
      { fetchImpl: fetchStub(answers), lookup, timeoutMs: 5000 },
    )
    expect(result.status).toBe(200)
    expect(result.body).toBe('final')
    expect(result.url).toBe('https://b.example/y')
    expect(lookupHits.length).toBeGreaterThanOrEqual(2)
  })

  it('blocks a 302 redirect whose Location targets loopback', async () => {
    const answers: Record<string, Response> = {
      'https://a.example/x': new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }),
    }
    await expect(
      fetchDashboard(
        { url: 'https://a.example/x' },
        baseOptions(fetchStub(answers)),
      ),
    ).rejects.toThrow(/disallowed/)
  })

  it('enforces the maxRedirects cap', async () => {
    const answers: Record<string, Response> = {
      'https://a.example/1': new Response(null, {
        status: 302,
        headers: { location: 'https://a.example/2' },
      }),
      'https://a.example/2': new Response(null, {
        status: 302,
        headers: { location: 'https://a.example/3' },
      }),
      'https://a.example/3': new Response(null, {
        status: 302,
        headers: { location: 'https://a.example/4' },
      }),
    }
    await expect(
      fetchDashboard(
        { url: 'https://a.example/1' },
        { ...baseOptions(fetchStub(answers)), maxRedirects: 1 },
      ),
    ).rejects.toThrow(/too many redirects/)
  })
})

describe('fetchDashboard — timeout', () => {
  it('aborts a slow request via the AbortController', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl: typeof fetch = ((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }) as typeof fetch
      const promise = fetchDashboard(
        { url: 'https://example.com/slow' },
        { fetchImpl, lookup: publicLookup, timeoutMs: 100 },
      )
      const assertion = expect(promise).rejects.toThrow(/aborted|timed out/)
      await vi.advanceTimersByTimeAsync(150)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fetchDashboard — error message hygiene', () => {
  it('scrubs Authorization header values from wrapped errors', async () => {
    const fetchImpl: typeof fetch = (async () => {
      // Simulate a client library that echoes the auth header in its error.
      throw new Error(
        'network failure while sending Authorization: Bearer supersecret',
      )
    }) as typeof fetch
    await expect(
      fetchDashboard(
        {
          url: 'https://example.com/x',
          headers: { Authorization: 'Bearer supersecret' },
        },
        baseOptions(fetchImpl),
      ),
    ).rejects.toThrow(/\[REDACTED\]/)
    await expect(
      fetchDashboard(
        {
          url: 'https://example.com/x',
          headers: { Authorization: 'Bearer supersecret' },
        },
        baseOptions(fetchImpl),
      ),
    ).rejects.not.toThrow(/supersecret/)
  })
})
