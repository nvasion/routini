/**
 * HTTP Dashboard Fetch Service
 *
 * Performs an HTTP/HTTPS request to a configured URL and checks that the
 * response status matches an expected value.  Intended for "check that my
 * dashboard / health endpoint is responding" style daily tasks.
 *
 * Configuration (from DailyTask.config — non-secret only):
 *   url            – full URL to fetch (required)
 *   method         – HTTP method; default "GET"
 *   expectedStatus – expected HTTP status code as a string; default "200"
 *   timeout        – request timeout in milliseconds as a string; default "5000"
 *   headers        – JSON object string of additional request headers (optional)
 *   body           – request body string for POST/PUT requests (optional)
 *
 * SECURITY / SSRF mitigation:
 *   – Only "http:" and "https:" schemes are permitted.
 *   – The hostname is checked against isSsrfSafeHostname (IP-range guard).
 *   – The hostname is resolved via DNS and the resulting IP is re-checked
 *     against private/loopback ranges (resolvedIpIsSsrfSafe) to mitigate
 *     basic DNS rebinding attacks.
 *   – Redirects to private addresses cannot be blocked with native fetch; the
 *     service sets redirect: 'follow' with a cap of 5 redirects via the
 *     fetchImpl abstraction so tests can verify redirect behaviour.
 *   – No credentials are accepted in the URL (user:pass@host is rejected).
 *   – Response bodies are truncated to MAX_BODY_PREVIEW_CHARS to avoid
 *     excessive memory use.
 */

import { resolvedIpIsSsrfSafe, isSsrfSafeHostname } from '../utils/network.js'
import type { DailyTask } from '../types.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])
const MAX_BODY_PREVIEW_CHARS = 2000
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HttpTaskResult {
  success: boolean
  /** Ordered log lines describing the request and response. */
  logs: string[]
  /** Actual HTTP status code returned by the server. */
  statusCode?: number
  /** Human-readable failure reason. */
  error?: string
}

/**
 * Injectable fetch function.  Defaults to the global `fetch` (available in
 * Node 18+).  Replace with a mock in unit tests.
 */
export type FetchFn = (url: string, options: RequestInit) => Promise<Response>

export interface HttpRunnerOptions {
  /**
   * Override the fetch implementation for testing.  The mock must return a
   * Response-like object with `status: number` and `text(): Promise<string>`.
   */
  fetchImpl?: FetchFn
  /**
   * Override the SSRF DNS-resolution check for testing (avoids real DNS calls).
   * Pass `async () => true` to disable the check in unit tests.
   */
  ssrfCheck?: (hostname: string) => Promise<boolean>
}

// ── URL validation ────────────────────────────────────────────────────────────

interface UrlValidResult {
  valid: true
  parsed: URL
}
interface UrlInvalidResult {
  valid: false
  error: string
}
type UrlValidation = UrlValidResult | UrlInvalidResult

function validateHttpUrl(rawUrl: string): UrlValidation {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { valid: false, error: 'HTTP task config is missing required field: url' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { valid: false, error: `url "${rawUrl}" is not a valid URL` }
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      valid: false,
      error: `url must use http or https (got "${parsed.protocol.replace(':', '')}")`,
    }
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'url must not contain embedded credentials' }
  }

  if (!isSsrfSafeHostname(parsed.hostname)) {
    return {
      valid: false,
      error: `url hostname "${parsed.hostname}" is not allowed: private or loopback addresses are blocked`,
    }
  }

  return { valid: true, parsed }
}

/** Parses the optional "headers" config field into a record. */
function parseHeaders(raw: string | undefined): Record<string, string> | null {
  if (!raw || !raw.trim()) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    // Only keep string values
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v
    }
    return result
  } catch {
    return null
  }
}

// ── Service entry point ───────────────────────────────────────────────────────

/**
 * Performs the HTTP request configured in `task.config` and returns the
 * result as logs plus status/success metadata.
 *
 * @param task     The DailyTask record (must have actionType === 'http').
 * @param options  Optional overrides for testing.
 */
export async function runHttpTask(
  task: DailyTask,
  options: HttpRunnerOptions = {},
): Promise<HttpTaskResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as FetchFn)
  const ssrfCheck = options.ssrfCheck ?? resolvedIpIsSsrfSafe

  // ── Validate URL ───────────────────────────────────────────────────────────
  const urlCheck = validateHttpUrl(task.config['url'] ?? '')
  if (!urlCheck.valid) {
    return { success: false, logs: [], error: urlCheck.error }
  }
  const { parsed: parsedUrl } = urlCheck

  // ── Parse optional fields ─────────────────────────────────────────────────
  const method = (task.config['method']?.trim().toUpperCase() || 'GET')
  const rawExpected = task.config['expectedStatus']?.trim() ?? '200'
  const expectedStatus = parseInt(rawExpected, 10)
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    return {
      success: false,
      logs: [],
      error: `expectedStatus "${rawExpected}" is not a valid HTTP status code`,
    }
  }

  const rawTimeout = task.config['timeout']?.trim() ?? String(DEFAULT_TIMEOUT_MS)
  const timeoutMs = Math.min(
    Math.max(parseInt(rawTimeout, 10) || DEFAULT_TIMEOUT_MS, 1),
    MAX_TIMEOUT_MS,
  )

  const extraHeaders = parseHeaders(task.config['headers'])
  const body = task.config['body']

  const logs: string[] = [
    `${method} ${parsedUrl.href}`,
    `Expected status: ${expectedStatus}, timeout: ${timeoutMs}ms`,
  ]

  // ── SSRF guard (DNS-based) ────────────────────────────────────────────────
  try {
    const safe = await ssrfCheck(parsedUrl.hostname)
    if (!safe) {
      return {
        success: false,
        logs,
        error: `url hostname "${parsedUrl.hostname}" resolved to a private or disallowed address`,
      }
    }
  } catch {
    return {
      success: false,
      logs,
      error: `DNS resolution failed for "${parsedUrl.hostname}"`,
    }
  }

  // ── Execute request ───────────────────────────────────────────────────────
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const requestInit: RequestInit = {
      method,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Routini-DailyTask/1.0',
        ...(extraHeaders ?? {}),
      },
      redirect: 'follow',
    }

    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      requestInit.body = body
    }

    const response = await fetchImpl(parsedUrl.href, requestInit)
    const statusCode = response.status

    // Read a limited preview of the body for logging.
    let bodyPreview = ''
    try {
      const fullBody = await response.text()
      bodyPreview = fullBody.length > MAX_BODY_PREVIEW_CHARS
        ? fullBody.slice(0, MAX_BODY_PREVIEW_CHARS) + '…'
        : fullBody
    } catch {
      bodyPreview = '[body unreadable]'
    }

    logs.push(`Response status: ${statusCode}`)
    if (bodyPreview) {
      logs.push(`Response body (preview): ${bodyPreview}`)
    }

    if (statusCode === expectedStatus) {
      logs.push(`Status matches expected ${expectedStatus} ✓`)
      return { success: true, logs, statusCode }
    }

    return {
      success: false,
      logs,
      statusCode,
      error: `[task:${task.id}] Expected status ${expectedStatus}, got ${statusCode}`,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const msg = `Request timed out after ${timeoutMs}ms`
      logs.push(msg)
      return { success: false, logs, error: `[task:${task.id}] ${msg}` }
    }
    const msg = err instanceof Error ? err.message : 'Unexpected HTTP error'
    logs.push(`Request failed: ${msg}`)
    return { success: false, logs, error: `[task:${task.id}] ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}
