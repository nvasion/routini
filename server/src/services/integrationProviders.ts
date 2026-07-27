/**
 * Integration provider health checks
 *
 * Implements the live "test connection" call for each of the v1 integration
 * providers (GitHub, Slack, Jira, Notion, Linear, monday.com, HubSpot). Each
 * check makes a single, cheap, read-only API call using the stored
 * credentials and reports whether the credentials are valid.
 *
 * These checks are invoked exclusively from the server (POST
 * /api/integrations/:id/test) — credentials never leave the server process.
 *
 * SECURITY:
 *   – Every provider except Jira calls a fixed, hard-coded first-party API
 *     host, so there is no user-controlled URL and therefore no SSRF surface.
 *   – Jira is the one exception: the user supplies `siteUrl` (their Atlassian
 *     site). It is validated the same way the HTTP daily-task service
 *     validates URLs (server/src/services/http.ts): http(s) only, no
 *     embedded credentials, and both the literal hostname and its resolved
 *     IP are checked against private/loopback ranges before the request is
 *     made (server/src/utils/network.ts).
 *   – Requests use a bounded timeout (AbortController) so a slow or hanging
 *     provider cannot tie up the server indefinitely.
 *   – Error messages returned to callers never include the raw credential
 *     value or the raw fetch error — only a small, fixed set of safe,
 *     descriptive strings (HTTP status codes, provider-defined error codes
 *     such as Slack's `invalid_auth`, or generic "timed out" / "network
 *     error" text).
 */

import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Injectable fetch implementation so tests never make real network calls. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface ProviderTestContext {
  /** Overrides the global fetch; defaults to the runtime's `fetch`. */
  fetchImpl?: FetchFn
  /** Overrides the DNS-based SSRF guard (Jira only); defaults to resolvedIpIsSsrfSafe. */
  ssrfCheck?: (hostname: string) => Promise<boolean>
  /** Overrides the per-request timeout (ms); defaults to 10s. Exposed for tests. */
  timeoutMs?: number
}

export interface ProviderTestResult {
  ok: boolean
  /** Short, safe-to-display description of the outcome. */
  message: string
}

const DEFAULT_TIMEOUT_MS = 10_000

// ── Shared fetch helper ───────────────────────────────────────────────────────

interface FetchResult {
  status: number
  body: unknown
}

/** True when a value is a plain JSON object (used to safely index provider response bodies). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Perform a fetch with a bounded timeout and best-effort JSON parsing. Never
 * throws for a normal HTTP error response (4xx/5xx) — only for network
 * failures / timeouts, which callers translate into a safe ProviderTestResult.
 */
async function fetchJson(
  fetchImpl: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** Translates a thrown fetch error into a safe, generic result — never echoes err.message. */
function networkFailureResult(providerName: string, err: unknown): ProviderTestResult {
  if (err instanceof Error && err.name === 'AbortError') {
    return { ok: false, message: `${providerName} request timed out` }
  }
  return { ok: false, message: `Network error while contacting ${providerName}` }
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async function testGithub(
  creds: Record<string, string>,
  ctx: ProviderTestContext,
): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status } = await fetchJson(
      fetchImpl,
      'https://api.github.com/user',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds['token']}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Routini-Integrations/1.0',
        },
      },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'GitHub token is valid' }
    }
    return { ok: false, message: `GitHub API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('GitHub', err)
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function testSlack(
  creds: Record<string, string>,
  ctx: ProviderTestContext,
): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    // auth.test always responds 200; success/failure is carried in the body.
    const { status, body } = await fetchJson(
      fetchImpl,
      'https://slack.com/api/auth.test',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds['botToken']}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status) && isRecord(body) && body['ok'] === true) {
      return { ok: true, message: 'Slack bot token is valid' }
    }
    const slackError = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : `status ${status}`
    return { ok: false, message: `Slack auth.test failed (${slackError})` }
  } catch (err) {
    return networkFailureResult('Slack', err)
  }
}

// ── Jira ──────────────────────────────────────────────────────────────────────

async function testJira(
  creds: Record<string, string>,
  ctx: ProviderTestContext,
): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  const ssrfCheck = ctx.ssrfCheck ?? resolvedIpIsSsrfSafe
  const rawSiteUrl = creds['siteUrl'] ?? ''

  let parsed: URL
  try {
    parsed = new URL(rawSiteUrl)
  } catch {
    return { ok: false, message: 'Jira site URL is not a valid URL' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Jira site URL must use http or https' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: 'Jira site URL must not contain embedded credentials' }
  }
  if (!isSsrfSafeHostname(parsed.hostname)) {
    return { ok: false, message: 'Jira site URL host is not allowed (private/loopback address)' }
  }

  try {
    const safe = await ssrfCheck(parsed.hostname)
    if (!safe) {
      return { ok: false, message: 'Jira site URL host is not allowed (private/loopback address)' }
    }
  } catch {
    return { ok: false, message: 'Jira site URL could not be resolved' }
  }

  const target = new URL('/rest/api/3/myself', parsed).toString()
  const basicAuth = Buffer.from(`${creds['email']}:${creds['apiToken']}`, 'utf8').toString('base64')

  try {
    const { status } = await fetchJson(
      fetchImpl,
      target,
      {
        method: 'GET',
        headers: { Authorization: `Basic ${basicAuth}`, Accept: 'application/json' },
      },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'Jira credentials are valid' }
    }
    return { ok: false, message: `Jira API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Jira', err)
  }
}

// ── Notion ────────────────────────────────────────────────────────────────────

async function testNotion(
  creds: Record<string, string>,
  ctx: ProviderTestContext,
): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status } = await fetchJson(
      fetchImpl,
      'https://api.notion.com/v1/users/me',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds['token']}`,
          'Notion-Version': '2022-06-28',
        },
      },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'Notion token is valid' }
    }
    return { ok: false, message: `Notion API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Notion', err)
  }
}

// ── Linear ────────────────────────────────────────────────────────────────────

async function testLinear(
  creds: Record<string, string>,
  ctx: ProviderTestContext,
): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status, body } = await fetchJson(
      fetchImpl,
      'https://api.linear.app/graphql',
      {
        method: 'POST',
        headers: {
          Authorization: creds['apiKey'] ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: '{ viewer { id } }' }),
      },
      ctx.timeoutMs,
    )
    const viewerId = isRecord(body) && isRecord(body['data']) ? body['data']['viewer'] : undefined
    if (isSuccessStatus(status) && isRecord(body) && !body['errors'] && viewerId) {
      return { ok: true, message: 'Linear API key is valid' }
    }
    return { ok: false, message: `Linear API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Linear', err)
  }
}

// ── monday.com ────────────────────────────────────────────────────────────────

async function testMonday(
  creds: Record<string, string>,
  ctx: ProviderTestContext,
): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status, body } = await fetchJson(
      fetchImpl,
      'https://api.monday.com/v2',
      {
        method: 'POST',
        headers: {
          Authorization: creds['apiToken'] ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'query { me { id } }' }),
      },
      ctx.timeoutMs,
    )
    const me = isRecord(body) && isRecord(body['data']) ? body['data']['me'] : undefined
    if (isSuccessStatus(status) && isRecord(body) && !body['errors'] && me) {
      return { ok: true, message: 'monday.com API token is valid' }
    }
    return { ok: false, message: `monday.com API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('monday.com', err)
  }
}

// ── HubSpot ───────────────────────────────────────────────────────────────────

async function testHubspot(
  creds: Record<string, string>,
  ctx: ProviderTestContext,
): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status } = await fetchJson(
      fetchImpl,
      'https://api.hubapi.com/account-info/v3/details',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${creds['token']}` },
      },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'HubSpot token is valid' }
    }
    return { ok: false, message: `HubSpot API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('HubSpot', err)
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

type ProviderTestFn = (
  creds: Record<string, string>,
  ctx: ProviderTestContext,
) => Promise<ProviderTestResult>

const PROVIDER_TESTS: Readonly<Record<string, ProviderTestFn>> = {
  github: testGithub,
  slack: testSlack,
  jira: testJira,
  notion: testNotion,
  linear: testLinear,
  monday: testMonday,
  hubspot: testHubspot,
}

/** Returns true when a live test implementation exists for the given integration id. */
export function hasProviderTest(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_TESTS, id)
}

/**
 * Runs the live provider health check for `id` using the supplied decrypted
 * credential fields. Throws if no provider test is registered for `id` —
 * callers must check `hasProviderTest` (or only call this for catalog ids).
 */
export async function runProviderTest(
  id: string,
  creds: Record<string, string>,
  ctx: ProviderTestContext = {},
): Promise<ProviderTestResult> {
  const fn = PROVIDER_TESTS[id]
  if (!fn) {
    throw new Error(`No provider test is implemented for integration "${id}"`)
  }
  return fn(creds, ctx)
}
