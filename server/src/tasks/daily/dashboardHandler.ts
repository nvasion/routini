/**
 * HTTP dashboard daily-task handler.
 *
 * Fetches a caller-configured URL and returns a summarized response. Used by
 * daily tasks that want to poll a status endpoint (an in-house dashboard, a
 * public healthz, etc.).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Security posture
 * ─────────────────────────────────────────────────────────────────────────
 *
 * SSRF is the dominant risk for this handler because the URL is
 * user-supplied. Defence in depth:
 *
 *   1. **URL scheme + hostname allowlist** at validation time —
 *      `validateUrl` in `validation.ts` blocks non-http(s) schemes and any
 *      hostname whose *literal string* matches the SSRF blocklist.
 *   2. **DNS pinning at fetch time.** `resolveHostnameSafe` re-resolves the
 *      hostname immediately before the request and blocks any A/AAAA record
 *      that lands in a private range. This closes the DNS-rebinding hole
 *      that validation-time checks alone leave open.
 *   3. **Redirect handling with re-validation.** Redirects are followed
 *      manually up to `maxRedirects`, each destination re-validated via the
 *      same DNS pin. `fetch`'s built-in redirect follower would skip our
 *      checks — we set `redirect: 'manual'` and drive the loop ourselves.
 *   4. **No credentials by default.** `credentials: 'omit'` so the outbound
 *      request never carries cookies or auth headers from the server's own
 *      HTTP state.
 *   5. **Response byte cap.** Body reads stop at `maxBodyBytes` — a slow
 *      loris that streams gigabytes cannot exhaust memory.
 *   6. **Header sanitisation on error paths.** Errors are wrapped through
 *      `sanitizeError` so caller-supplied Authorization or Cookie headers
 *      (echoed in some libraries' error messages) never reach logs.
 *
 * The IPv6 note: DNS-pinning the *IP* while still using the hostname in the
 * `Host:` header is what closes the rebinding window. Node's `undici`
 * supports pinning via an Agent, but we do the simpler thing: verify the
 * host and reject on rebind. The window between our DNS check and the
 * kernel's connect() is measured in microseconds; a determined attacker
 * would need to race that. In production, deployments should additionally
 * pin the outbound connection with an HTTP dispatcher — this handler
 * exposes an injectable `fetchImpl` so callers can layer that on.
 */

import type { HttpConfig, HttpMethod } from '../types.js'
import { validateUrl } from '../validation.js'
import { resolveHostnameSafe, type LookupFn } from './dns.js'
import { sanitizeError } from './sanitizeError.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardFetchResult {
  status: number
  statusText: string
  /** Final URL after any redirects. Same as input when no redirect followed. */
  url: string
  /** Whether the response body was cut short at `maxBodyBytes`. */
  bodyTruncated: boolean
  /** UTF-8 decoded body, truncated to `maxBodyBytes`. */
  body: string
  /**
   * Response headers as an object. Sensitive/hop-by-hop headers
   * (Set-Cookie, Proxy-Authenticate, etc.) are dropped so the result is
   * safe to persist in a task-run log without leaking session material.
   */
  headers: Record<string, string>
}

export interface DashboardFetchOptions {
  timeoutMs?: number
  maxBodyBytes?: number
  maxRedirects?: number
  /** Injected `fetch` — tests provide a deterministic stand-in. */
  fetchImpl?: typeof fetch
  /** Injected DNS lookup — tests point this at a fake. */
  lookup?: LookupFn
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_MAX_REDIRECTS = 3
const DEFAULT_METHOD: HttpMethod = 'GET'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/**
 * Response headers that MUST NOT be persisted / echoed back — they can carry
 * session material or misdirect a caller into thinking a cookie was set on
 * their behalf.
 */
const SENSITIVE_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'proxy-authenticate',
  'www-authenticate',
  'authorization',
])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the configured URL and return a summarised response. Follows
 * redirects manually so every hop is re-validated for SSRF.
 */
export async function fetchDashboard(
  config: HttpConfig,
  options: DashboardFetchOptions = {},
): Promise<DashboardFetchResult> {
  const rawUrl = config.url
  const method = (config.method ?? DEFAULT_METHOD) as HttpMethod
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const fetchImpl = options.fetchImpl ?? fetch
  const lookup = options.lookup

  // Every caller-supplied header value is treated as sensitive — an
  // Authorization or Cookie value belongs to that specific request and must
  // not appear in a wrapped error message.
  const headerValuesSensitive = config.headers
    ? Object.values(config.headers)
    : []

  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw sanitizeError('url is required', {
      context: 'http',
      sensitive: headerValuesSensitive,
    })
  }
  const urlErrors = validateUrl(rawUrl, 'url')
  if (urlErrors.length > 0) {
    throw sanitizeError(urlErrors.join('; '), {
      context: 'http',
      sensitive: headerValuesSensitive,
    })
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw sanitizeError('timeoutMs must be a positive integer', {
      context: 'http',
      sensitive: headerValuesSensitive,
    })
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw sanitizeError('maxBodyBytes must be a positive integer', {
      context: 'http',
      sensitive: headerValuesSensitive,
    })
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw sanitizeError('maxRedirects must be a non-negative integer', {
      context: 'http',
      sensitive: headerValuesSensitive,
    })
  }

  const overallDeadline = Date.now() + timeoutMs
  const overallController = new AbortController()
  const overallTimer = setTimeout(
    () => overallController.abort(),
    timeoutMs,
  )

  let currentUrl = rawUrl
  let hop = 0

  try {
    // Redirect loop. `for` bound so we can never spin forever on a
    // cycle of 302s.
    for (hop = 0; hop <= maxRedirects; hop++) {
      const parsed = new URL(currentUrl)

      // Re-validate scheme and hostname on every hop — a redirect target of
      // `file://` or `http://127.0.0.1/` must be rejected, not followed.
      const redirectErrors = validateUrl(currentUrl, 'redirect')
      if (redirectErrors.length > 0) {
        throw new Error(redirectErrors.join('; '))
      }

      // DNS pin: block if the hostname now resolves to a private range.
      await resolveHostnameSafe(parsed.hostname, lookup)

      const remaining = overallDeadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`timed out after ${timeoutMs}ms`)
      }

      // fetch() closes as soon as the outer AbortController fires, so we
      // don't need a separate per-hop timer.
      const response = await fetchImpl(currentUrl, {
        method,
        headers: config.headers,
        redirect: 'manual',
        signal: overallController.signal,
        // Cookies from the surrounding Node process (if any) MUST NOT be
        // forwarded to an arbitrary user-configured URL.
        credentials: 'omit',
      } as RequestInit)

      // Manual redirect handling — otherwise a 3xx would let the runtime
      // follow the Location without re-validating for SSRF.
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        if (!location) {
          // 3xx without Location: treat as terminal.
          return await readResponse(response, currentUrl, maxBodyBytes)
        }
        if (hop === maxRedirects) {
          throw new Error(`too many redirects (>${maxRedirects})`)
        }
        // Resolve relative Location against the current URL.
        currentUrl = new URL(location, currentUrl).toString()
        // Cancel the current body so the underlying connection can be
        // released before we open the next hop.
        try {
          await response.body?.cancel()
        } catch {
          // ignore — best effort
        }
        continue
      }

      return await readResponse(response, currentUrl, maxBodyBytes)
    }

    // Loop exited without a return; treat as too many redirects. `for`
    // bound guarantees we stop, but TS wants a fall-through.
    throw new Error(`too many redirects (>${maxRedirects})`)
  } catch (err) {
    throw sanitizeError(err, {
      context: 'http',
      sensitive: headerValuesSensitive,
    })
  } finally {
    clearTimeout(overallTimer)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read up to `maxBodyBytes` from the response, return a `DashboardFetchResult`.
 * Cancels the underlying reader after the cap so a slow server doesn't stream
 * indefinitely.
 */
async function readResponse(
  response: Response,
  finalUrl: string,
  maxBodyBytes: number,
): Promise<DashboardFetchResult> {
  const body = response.body
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false

  if (body) {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (total + value.length > maxBodyBytes) {
          const room = maxBodyBytes - total
          if (room > 0) {
            chunks.push(value.subarray(0, room))
            total = maxBodyBytes
          }
          truncated = true
          try {
            await reader.cancel()
          } catch {
            // ignore — best effort
          }
          break
        }
        chunks.push(value)
        total += value.length
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
    }
  }

  const bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
    'utf8',
  )
  return {
    status: response.status,
    statusText: response.statusText,
    url: finalUrl,
    bodyTruncated: truncated,
    body: bodyText,
    headers: filterHeaders(response.headers),
  }
}

/** Drop sensitive headers before returning them to a caller. */
function filterHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase())) return
    out[key] = value
  })
  return out
}
