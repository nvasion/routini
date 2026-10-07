/**
 * Integration provider health checks
 *
 * Implements the live "test connection" call for each of the v1 integration
 * providers (GitHub, Slack, Jira, Notion, Linear, monday.com, HubSpot) plus
 * the v2 providers added alongside this module (Azure DevOps, Microsoft
 * Teams, GitLab, DigitalOcean, Sentry, PagerDuty, Datadog, Cloudflare). Each
 * check makes a single, cheap, read-only API call using the stored
 * credentials and reports whether the credentials are valid.
 *
 * These checks are invoked exclusively from the server (POST
 * /api/integrations/:id/test) — credentials never leave the server process.
 *
 * SECURITY:
 *   – Most providers call a fixed, hard-coded first-party API host, so there
 *     is no user-controlled URL and therefore no SSRF surface.
 *   – Jira, GitLab, and Microsoft Teams are the exceptions, each with a
 *     user-controlled endpoint:
 *       – Jira (`siteUrl`) and GitLab (`baseUrl`) are validated the same way
 *         the HTTP daily-task service validates URLs
 *         (server/src/services/http.ts): http(s) only, no embedded
 *         credentials, and both the literal hostname and its resolved IP are
 *         checked against private/loopback ranges before the request is made
 *         (server/src/utils/network.ts) — unless `ctx.allowPrivateHosts` is
 *         set for self-hosted installs.
 *       – Datadog (`apiUrl`) is allow-listed against the fixed set of
 *         `api.<site>.datadoghq.*` hosts Datadog publishes, so an
 *         SSRF-capable URL is rejected outright rather than checked for
 *         "privateness".
 *       – Microsoft Teams (`webhookUrl`) is allow-listed against Microsoft's
 *         webhook-receiving hostname suffixes (see
 *         server/src/integrations/teams.ts), for the same reason.
 *   – Requests use a bounded timeout (AbortController) so a slow or hanging
 *     provider cannot tie up the server indefinitely.
 *   – Error messages returned to callers never include the raw credential
 *     value or the raw fetch error — only a small, fixed set of safe,
 *     descriptive strings (HTTP status codes, provider-defined error codes
 *     such as Slack's `invalid_auth`, or generic "timed out" / "network
 *     error" text).
 */

import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'
import { ADO_API_VERSION, adoAuthHeader, adoBaseUrl, isValidAdoOrganization } from './azureDevops.js'
import { postTeamsMessage, validateTeamsWebhookUrl } from './teams.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Injectable fetch implementation so tests never make real network calls. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface ProviderTestContext {
  /** Overrides the global fetch; defaults to the runtime's `fetch`. */
  fetchImpl?: FetchFn
  /** Overrides the DNS-based SSRF guard (Jira only); defaults to resolvedIpIsSsrfSafe. */
  ssrfCheck?: (hostname: string) => Promise<boolean>
  /** Self-hosted installs may reach private addresses (e.g. an internal Factory). */
  allowPrivateHosts?: boolean
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

  // https only: the API token travels in a basic-auth header.
  if (parsed.protocol !== 'https:') {
    return { ok: false, message: 'Jira site URL must use https' }
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

// ── Azure DevOps ──────────────────────────────────────────────────────────────

async function testAzureDevops(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  const org = creds['organization'] ?? ''
  if (!isValidAdoOrganization(org)) {
    return { ok: false, message: 'Azure DevOps organization name is not valid' }
  }
  try {
    const { status, body } = await fetchJson(
      fetchImpl,
      `${adoBaseUrl(org)}/_apis/projects?api-version=${ADO_API_VERSION}&$top=1`,
      {
        method: 'GET',
        headers: { Authorization: adoAuthHeader(creds['pat'] ?? ''), Accept: 'application/json' },
      },
      ctx.timeoutMs,
    )
    // ADO answers 203 (and sometimes a plain 2xx) with an HTML sign-in page
    // when the PAT is invalid, instead of a JSON body with a numeric `count`.
    if (isSuccessStatus(status) && !(isRecord(body) && typeof body['count'] === 'number')) {
      return { ok: false, message: 'Azure DevOps did not accept the token (sign-in page returned)' }
    }
    if (isSuccessStatus(status)) {
      return { ok: true, message: `Azure DevOps token is valid for ${org}` }
    }
    return { ok: false, message: `Azure DevOps API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Azure DevOps', err)
  }
}

// ── Microsoft Teams ───────────────────────────────────────────────────────────

async function testTeams(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const webhookUrl = creds['webhookUrl'] ?? ''
  try {
    validateTeamsWebhookUrl(webhookUrl)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Teams webhook URL is not valid' }
  }
  try {
    const { ok, status } = await postTeamsMessage(
      webhookUrl,
      { text: 'Routini is connected to this channel.', title: 'Routini' },
      { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs },
    )
    if (ok) {
      return { ok: true, message: 'Teams webhook accepted a test message' }
    }
    return { ok: false, message: `Teams webhook returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Microsoft Teams', err)
  }
}

// ── GitLab ────────────────────────────────────────────────────────────────────

async function testGitlab(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  const ssrfCheck = ctx.ssrfCheck ?? resolvedIpIsSsrfSafe
  let parsed: URL
  try {
    parsed = new URL(creds['baseUrl'] || 'https://gitlab.com')
  } catch {
    return { ok: false, message: 'GitLab URL is not a valid URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'GitLab URL must use http or https' }
  }
  if (!ctx.allowPrivateHosts && parsed.protocol !== 'https:') {
    return { ok: false, message: 'GitLab URL must use https' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: 'GitLab URL must not contain embedded credentials' }
  }
  if (!ctx.allowPrivateHosts) {
    if (!isSsrfSafeHostname(parsed.hostname)) return { ok: false, message: 'GitLab URL host is not allowed (private/loopback address)' }
    try {
      if (!(await ssrfCheck(parsed.hostname))) return { ok: false, message: 'GitLab URL host is not allowed (private/loopback address)' }
    } catch {
      return { ok: false, message: 'GitLab URL could not be resolved' }
    }
  }
  try {
    const { status } = await fetchJson(
      fetchImpl,
      new URL('/api/v4/user', parsed).toString(),
      { method: 'GET', headers: { 'PRIVATE-TOKEN': creds['token'] ?? '', Accept: 'application/json' } },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'GitLab token is valid' }
    }
    return { ok: false, message: `GitLab API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('GitLab', err)
  }
}

// ── DigitalOcean ──────────────────────────────────────────────────────────────

async function testDigitalocean(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status } = await fetchJson(
      fetchImpl,
      'https://api.digitalocean.com/v2/account',
      { method: 'GET', headers: { Authorization: `Bearer ${creds['token'] ?? ''}` } },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'DigitalOcean token is valid' }
    }
    return { ok: false, message: `DigitalOcean API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('DigitalOcean', err)
  }
}

// ── Sentry ────────────────────────────────────────────────────────────────────

async function testSentry(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status } = await fetchJson(
      fetchImpl,
      'https://sentry.io/api/0/organizations/',
      { method: 'GET', headers: { Authorization: `Bearer ${creds['token'] ?? ''}` } },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'Sentry token is valid' }
    }
    return { ok: false, message: `Sentry API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Sentry', err)
  }
}

// ── PagerDuty ─────────────────────────────────────────────────────────────────

async function testPagerduty(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status } = await fetchJson(
      fetchImpl,
      'https://api.pagerduty.com/abilities',
      {
        method: 'GET',
        headers: { Authorization: `Token token=${creds['apiKey'] ?? ''}`, Accept: 'application/vnd.pagerduty+json;version=2' },
      },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      return { ok: true, message: 'PagerDuty API key is valid' }
    }
    return { ok: false, message: `PagerDuty API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('PagerDuty', err)
  }
}

// ── Datadog ───────────────────────────────────────────────────────────────────

/** Hosts Datadog publishes for its regional API sites (api.<site>.datadoghq.*). */
const DATADOG_API_HOSTS = [
  'api.datadoghq.com',
  'api.us3.datadoghq.com',
  'api.us5.datadoghq.com',
  'api.datadoghq.eu',
  'api.ap1.datadoghq.com',
  'api.ap2.datadoghq.com',
  'api.ddog-gov.com',
]

async function testDatadog(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  let parsed: URL
  try {
    parsed = new URL(creds['apiUrl'] ?? '')
  } catch {
    return { ok: false, message: 'Datadog API URL is not a valid URL' }
  }
  if (parsed.protocol !== 'https:' || !DATADOG_API_HOSTS.includes(parsed.hostname.toLowerCase())) {
    return { ok: false, message: 'Datadog API URL must be https://api.<your Datadog site>' }
  }
  try {
    const { status, body } = await fetchJson(
      fetchImpl,
      new URL('/api/v1/validate', parsed).toString(),
      {
        method: 'GET',
        headers: { 'DD-API-KEY': creds['apiKey'] ?? '', 'DD-APPLICATION-KEY': creds['appKey'] ?? '', Accept: 'application/json' },
      },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status) && isRecord(body) && body['valid'] === true) {
      return { ok: true, message: 'Datadog keys are valid' }
    }
    return { ok: false, message: `Datadog API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Datadog', err)
  }
}

// ── Cloudflare ────────────────────────────────────────────────────────────────

async function testCloudflare(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  try {
    const { status, body } = await fetchJson(
      fetchImpl,
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { method: 'GET', headers: { Authorization: `Bearer ${creds['token'] ?? ''}` } },
      ctx.timeoutMs,
    )
    if (isSuccessStatus(status)) {
      const result = isRecord(body) ? body['result'] : undefined
      if (isRecord(body) && body['success'] === true && isRecord(result) && result['status'] === 'active') {
        return { ok: true, message: 'Cloudflare API token is valid' }
      }
      return { ok: false, message: 'Cloudflare token is not active' }
    }
    return { ok: false, message: `Cloudflare API returned status ${status}` }
  } catch (err) {
    return networkFailureResult('Cloudflare', err)
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

type ProviderTestFn = (
  creds: Record<string, string>,
  ctx: ProviderTestContext,
) => Promise<ProviderTestResult>

// ── Factory ─────────────────────────────────────────────────────────────────────

async function testFactory(creds: Record<string, string>, ctx: ProviderTestContext): Promise<ProviderTestResult> {
  const fetchImpl = ctx.fetchImpl ?? (fetch as FetchFn)
  const ssrfCheck = ctx.ssrfCheck ?? resolvedIpIsSsrfSafe
  let parsed: URL
  try {
    parsed = new URL(creds['baseUrl'] || 'https://factory-nexus.ai')
  } catch {
    return { ok: false, message: 'Factory URL is not a valid URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, message: 'Factory URL must use http or https' }
  if (parsed.username || parsed.password) return { ok: false, message: 'Factory URL must not contain embedded credentials' }
  if (!ctx.allowPrivateHosts) {
    if (!isSsrfSafeHostname(parsed.hostname)) return { ok: false, message: 'Factory URL host is not allowed (private/loopback address)' }
    try {
      if (!(await ssrfCheck(parsed.hostname))) return { ok: false, message: 'Factory URL host is not allowed (private/loopback address)' }
    } catch {
      return { ok: false, message: 'Factory URL could not be resolved' }
    }
  }
  try {
    const { status, body } = await fetchJson(fetchImpl, new URL('/api/auth/me', parsed).toString(), { method: 'GET', headers: { Authorization: `Bearer ${creds['apiToken']}`, Accept: 'application/json' } }, ctx.timeoutMs)
    if (!isSuccessStatus(status)) return { ok: false, message: `Factory returned status ${status}` }
    const who = isRecord(body) && typeof body['email'] === 'string' ? ` as ${body['email']}` : ''
    return { ok: true, message: `Factory API key is valid${who}` }
  } catch (err) {
    return networkFailureResult('Factory', err)
  }
}

const PROVIDER_TESTS: Readonly<Record<string, ProviderTestFn>> = {
  factory: testFactory,
  github: testGithub,
  slack: testSlack,
  jira: testJira,
  notion: testNotion,
  linear: testLinear,
  monday: testMonday,
  hubspot: testHubspot,
  'azure-devops': testAzureDevops,
  teams: testTeams,
  gitlab: testGitlab,
  digitalocean: testDigitalocean,
  sentry: testSentry,
  pagerduty: testPagerduty,
  datadog: testDatadog,
  cloudflare: testCloudflare,
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
