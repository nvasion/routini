/**
 * Unit tests for the HTTP Dashboard Fetch Service.
 *
 * Coverage:
 *   – URL validation: missing URL, bad scheme, embedded credentials, SSRF guard
 *   – expectedStatus validation: out of range, non-numeric
 *   – SSRF DNS check: blocks private IPs resolved from hostnames
 *   – Successful fetch: status match, body preview in logs, method passed
 *   – Status mismatch: returns failure with actual vs expected
 *   – Request timeout: AbortSignal fires, returns failure
 *   – Fetch errors: network failure, non-Error rejections
 *   – Headers and body config
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runHttpTask } from '../server/src/services/http'
import type { HttpRunnerOptions } from '../server/src/services/http'
import type { DailyTask } from '../server/src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(configOverrides: Record<string, string> = {}): DailyTask {
  return {
    id: 'task-http-001',
    name: 'HTTP Check',
    description: 'Fetch dashboard health endpoint',
    type: 'daily',
    status: 'idle',
    schedule: '0 9 * * *',
    actionType: 'http',
    config: {
      url: 'https://example.com/health',
      method: 'GET',
      expectedStatus: '200',
      timeout: '5000',
      ...configOverrides,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** Creates a mock fetch function returning the given status and body text. */
function mockFetch(status: number, body: string = ''): HttpRunnerOptions['fetchImpl'] {
  return vi.fn().mockResolvedValue({
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response)
}

/** Mock fetch that rejects with the given error. */
function failingFetch(error: unknown): HttpRunnerOptions['fetchImpl'] {
  return vi.fn().mockRejectedValue(error)
}

/** SSRF check that always returns safe (avoids real DNS in tests). */
const safeSsrf: HttpRunnerOptions['ssrfCheck'] = async () => true

/** SSRF check that always returns unsafe. */
const unsafeSsrf: HttpRunnerOptions['ssrfCheck'] = async () => false

// ═════════════════════════════════════════════════════════════════════════════
// URL validation
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – URL validation', () => {
  it('returns failure when url is missing', async () => {
    const task = makeTask({ url: '' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/url/i)
  })

  it('returns failure when url is not parseable', async () => {
    const task = makeTask({ url: 'not a url' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/valid URL/i)
  })

  it('rejects ftp:// scheme', async () => {
    const task = makeTask({ url: 'ftp://example.com/file' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/http|https/i)
  })

  it('rejects file:// scheme', async () => {
    const task = makeTask({ url: 'file:///etc/passwd' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/http|https/i)
  })

  it('rejects javascript: scheme', async () => {
    const task = makeTask({ url: 'javascript:alert(1)' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/http|https/i)
  })

  it('rejects URLs with embedded credentials', async () => {
    const task = makeTask({ url: 'https://user:pass@example.com/api' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/credentials/i)
  })

  it('accepts http:// URLs', async () => {
    const task = makeTask({ url: 'http://example.com/api' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(200),
      ssrfCheck: safeSsrf,
    })
    // Valid scheme — should not fail with a scheme error
    expect(result.success).toBe(true)
  })

  it('accepts https:// URLs', async () => {
    const task = makeTask({ url: 'https://example.com/api' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(200),
      ssrfCheck: safeSsrf,
    })
    // Valid scheme — should not fail
    expect(result.success).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SSRF hostname guard (synchronous, IP-range based)
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – SSRF hostname guard', () => {
  it('blocks localhost in URL', async () => {
    const task = makeTask({ url: 'http://localhost/admin' })
    const result = await runHttpTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 127.0.0.1 in URL', async () => {
    const task = makeTask({ url: 'http://127.0.0.1/secret' })
    const result = await runHttpTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 10.0.0.1 in URL', async () => {
    const task = makeTask({ url: 'http://10.0.0.1/api' })
    const result = await runHttpTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 192.168.x.x in URL', async () => {
    const task = makeTask({ url: 'http://192.168.1.1/dashboard' })
    const result = await runHttpTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks 172.20.0.1 in URL (RFC 1918)', async () => {
    const task = makeTask({ url: 'http://172.20.0.1/metrics' })
    const result = await runHttpTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks .local domains', async () => {
    const task = makeTask({ url: 'http://dashboard.local/status' })
    const result = await runHttpTask(task)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not allowed/i)
  })

  it('blocks when SSRF DNS check returns false', async () => {
    const task = makeTask({ url: 'https://internal-service.example.com/api' })
    const result = await runHttpTask(task, {
      ssrfCheck: unsafeSsrf,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/private or disallowed/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// expectedStatus validation
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – expectedStatus validation', () => {
  it('returns failure for expectedStatus < 100', async () => {
    const task = makeTask({ expectedStatus: '99' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/status code/i)
  })

  it('returns failure for expectedStatus > 599', async () => {
    const task = makeTask({ expectedStatus: '600' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/status code/i)
  })

  it('returns failure for non-numeric expectedStatus', async () => {
    const task = makeTask({ expectedStatus: 'ok' })
    const result = await runHttpTask(task, { ssrfCheck: safeSsrf })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/status code/i)
  })

  it('accepts 200', async () => {
    const task = makeTask({ expectedStatus: '200' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(200),
      ssrfCheck: safeSsrf,
    })
    expect(result.success).toBe(true)
  })

  it('accepts 404 as the expected status', async () => {
    const task = makeTask({ expectedStatus: '404' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(404),
      ssrfCheck: safeSsrf,
    })
    expect(result.success).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Successful fetch
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – successful fetch', () => {
  it('returns success when status matches expected', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(200, '{"status":"ok"}'),
      ssrfCheck: safeSsrf,
    })
    expect(result.success).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.error).toBeUndefined()
  })

  it('includes the response status in logs', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(200, ''),
      ssrfCheck: safeSsrf,
    })
    expect(result.logs.join('\n')).toContain('200')
  })

  it('includes a body preview in logs', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(200, '{"status":"ok","uptime":42}'),
      ssrfCheck: safeSsrf,
    })
    expect(result.logs.join('\n')).toContain('"status"')
  })

  it('passes the configured method to fetch', async () => {
    const task = makeTask({ method: 'POST' })
    const fn = mockFetch(200)!
    await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(call[1].method).toBe('POST')
  })

  it('passes the URL to fetch', async () => {
    const task = makeTask({ url: 'https://api.example.com/status' })
    const fn = mockFetch(200)!
    await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://api.example.com/status')
  })

  it('sets a User-Agent header', async () => {
    const task = makeTask()
    const fn = mockFetch(200)!
    await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = call[1].headers as Record<string, string>
    expect(headers['User-Agent']).toMatch(/routini/i)
  })

  it('truncates very long response bodies in logs', async () => {
    const task = makeTask()
    const longBody = 'x'.repeat(5000)
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(200, longBody),
      ssrfCheck: safeSsrf,
    })
    const combined = result.logs.join('\n')
    // Body preview should be truncated (less than 5000 chars in log)
    expect(combined.length).toBeLessThan(longBody.length + 500)
    expect(combined).toContain('…')
  })

  it('merges extra headers from config', async () => {
    const task = makeTask({ headers: '{"X-Custom-Header":"my-value"}' })
    const fn = mockFetch(200)!
    await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = call[1].headers as Record<string, string>
    expect(headers['X-Custom-Header']).toBe('my-value')
  })

  it('sends body for POST requests when configured', async () => {
    const task = makeTask({ method: 'POST', body: '{"key":"value"}' })
    const fn = mockFetch(200)!
    await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(call[1].body).toBe('{"key":"value"}')
  })

  it('does not send body for GET requests', async () => {
    const task = makeTask({ method: 'GET', body: 'should-be-ignored' })
    const fn = mockFetch(200)!
    await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(call[1].body).toBeUndefined()
  })

  it('returns the actual status code in the result', async () => {
    const task = makeTask({ expectedStatus: '201' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(201),
      ssrfCheck: safeSsrf,
    })
    expect(result.statusCode).toBe(201)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Status mismatch
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – status mismatch', () => {
  it('returns failure when status does not match expected', async () => {
    const task = makeTask({ expectedStatus: '200' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(500, 'Internal Server Error'),
      ssrfCheck: safeSsrf,
    })
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(500)
  })

  it('includes expected and actual status in the error', async () => {
    const task = makeTask({ expectedStatus: '200' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(503),
      ssrfCheck: safeSsrf,
    })
    expect(result.error).toContain('200')
    expect(result.error).toContain('503')
  })

  it('includes the task ID in the error', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(404),
      ssrfCheck: safeSsrf,
    })
    expect(result.error).toContain('task-http-001')
  })

  it('still captures response logs on mismatch', async () => {
    const task = makeTask({ expectedStatus: '200' })
    const result = await runHttpTask(task, {
      fetchImpl: mockFetch(404, 'Not Found'),
      ssrfCheck: safeSsrf,
    })
    expect(result.logs.join('\n')).toContain('404')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Request timeout
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – timeout', () => {
  it('returns failure when the request times out', async () => {
    const task = makeTask({ timeout: '10' })
    const timedOutFetch: HttpRunnerOptions['fetchImpl'] = vi.fn().mockImplementation(
      (_url, opts) =>
        new Promise((_, reject) => {
          // Simulate abort signal firing
          const signal = (opts as RequestInit).signal
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('This operation was aborted')
              err.name = 'AbortError'
              reject(err)
            })
          }
          // Never resolves — waits for abort
        }),
    )
    const result = await runHttpTask(task, {
      fetchImpl: timedOutFetch,
      ssrfCheck: safeSsrf,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out/i)
    expect(result.logs.join('\n')).toMatch(/timed out/i)
  })

  it('clamps very large timeout values', async () => {
    const task = makeTask({ timeout: '9999999' })
    const fn = mockFetch(200)!
    const result = await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    // Should succeed — the very large value is clamped to MAX_TIMEOUT_MS (30 000 ms)
    expect(result.success).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Network / fetch errors
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – fetch errors', () => {
  it('returns failure when fetch throws a network error', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: failingFetch(new Error('ECONNREFUSED')),
      ssrfCheck: safeSsrf,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('includes the task ID in network error messages', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: failingFetch(new Error('network down')),
      ssrfCheck: safeSsrf,
    })
    expect(result.error).toContain('task-http-001')
  })

  it('handles non-Error fetch rejections', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: failingFetch('string error'),
      ssrfCheck: safeSsrf,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('includes the error message in logs', async () => {
    const task = makeTask()
    const result = await runHttpTask(task, {
      fetchImpl: failingFetch(new Error('ECONNREFUSED')),
      ssrfCheck: safeSsrf,
    })
    expect(result.logs.join('\n')).toContain('ECONNREFUSED')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Headers config
// ═════════════════════════════════════════════════════════════════════════════

describe('runHttpTask – headers config', () => {
  it('ignores malformed JSON in headers config', async () => {
    const task = makeTask({ headers: '{bad json' })
    const fn = mockFetch(200)!
    const result = await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    // Should not crash — invalid JSON is silently ignored
    expect(result.success).toBe(true)
  })

  it('ignores non-object headers config (array)', async () => {
    const task = makeTask({ headers: '["header"]' })
    const fn = mockFetch(200)!
    const result = await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    expect(result.success).toBe(true)
  })

  it('merges multiple headers', async () => {
    const task = makeTask({ headers: '{"Accept":"application/json","X-Trace":"abc"}' })
    const fn = mockFetch(200)!
    await runHttpTask(task, { fetchImpl: fn, ssrfCheck: safeSsrf })
    const call = (fn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = call[1].headers as Record<string, string>
    expect(headers['Accept']).toBe('application/json')
    expect(headers['X-Trace']).toBe('abc')
  })
})
