// ─────────────────────────────────────────────────────────────────────────────
// Jira backlog source. Contract: docs/work-intake-backlog.md section 6b.
//
// All network calls go through `ctx.fetch`; credentials come from
// `ctx.credentials('jira')` (fields `siteUrl`, `email`, `apiToken`), never
// from caller-supplied input. `siteUrl` is operator-controlled (not the
// caller's), but still checked against SSRF (private/loopback addresses)
// because a self-hosted install could point it anywhere; hosted installs
// never allow a private address (`ctx.allowPrivateHosts`).
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'
import type { AdapterCtx, SourceAdapter, SourceItem, StatusWrite } from './types.js'

const JIRA_API_VERSION = '3'
const JIRA_PAGE_SIZE = 100
const MAX_ITEMS = 500

export interface JiraConfig {
  jql: string
  /** A custom field id, e.g. `customfield_10050`. */
  repoField?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// ── Config ───────────────────────────────────────────────────────────────────

/** Validates a Jira source's config; throws SpecError naming the exact field. */
export function parseJiraConfig(raw: unknown): JiraConfig {
  if (!isObj(raw)) throw new SpecError('config must be an object')

  const jql = raw['jql']
  if (typeof jql !== 'string' || jql.trim() === '' || jql.length > 2000) {
    throw new SpecError('config.jql must be a non-empty string of at most 2000 characters')
  }

  const cfg: JiraConfig = { jql }
  const repoFieldRaw = raw['repoField']
  if (repoFieldRaw !== undefined) {
    if (typeof repoFieldRaw !== 'string' || repoFieldRaw.trim() === '' || repoFieldRaw.length > 60) {
      throw new SpecError('config.repoField must be a non-empty string of at most 60 characters')
    }
    cfg.repoField = repoFieldRaw
  }
  return cfg
}

// ── Site URL / SSRF guard ───────────────────────────────────────────────────

/**
 * Validates the Jira site URL (https, no embedded credentials) and, unless
 * private addresses are allowed, checks its hostname and resolved IP against
 * private/loopback ranges. `dnsCheck` defaults to the real DNS-based guard
 * and is overridable so tests can exercise the DNS-resolution path (a
 * public-looking hostname that resolves privately, or vice versa) without
 * making a real DNS query.
 */
export async function validateJiraSiteUrl(
  siteUrl: string,
  allowPrivateHosts: boolean,
  dnsCheck: (hostname: string) => Promise<boolean> = resolvedIpIsSsrfSafe,
): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(siteUrl)
  } catch {
    throw new Error('The Jira site URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('The Jira site URL must use https')
  }
  if (parsed.username || parsed.password) {
    throw new Error('The Jira site URL must not contain embedded credentials')
  }
  if (!allowPrivateHosts) {
    const safe = isSsrfSafeHostname(parsed.hostname) && (await dnsCheck(parsed.hostname).catch(() => false))
    if (!safe) throw new Error('The Jira site URL points at a private address')
  }
  return parsed
}

function jiraBasicAuth(creds: Record<string, string>): string {
  return Buffer.from(`${creds['email'] ?? ''}:${creds['apiToken'] ?? ''}`, 'utf8').toString('base64')
}

// ── ADF (Atlassian Document Format) ─────────────────────────────────────────

/** Concatenates every text leaf under an ADF node, in document order. */
function flattenAdfNode(node: unknown): string {
  if (!isObj(node)) return ''
  if (node['type'] === 'text' && typeof node['text'] === 'string') return node['text']
  const content = node['content']
  if (!Array.isArray(content)) return ''
  return content.map(flattenAdfNode).join('')
}

/** Flattens an ADF document to plain text, one line per top-level block. */
export function flattenAdf(doc: unknown): string {
  if (!isObj(doc) || !Array.isArray(doc['content'])) return ''
  return doc['content'].map(flattenAdfNode).join('\n')
}

/** Builds an ADF doc with one paragraph per line of `text`. */
function textToAdfDoc(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line === '' ? [] : [{ type: 'text', text: line }],
    })),
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

interface JiraResponse {
  status: number
  json: unknown
}

async function jiraRequest(ctx: AdapterCtx, basicAuth: string, method: string, url: string, body?: unknown): Promise<JiraResponse> {
  const res = await ctx.fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: ctx.signal,
  })
  let json: unknown
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

/** Turns a non-2xx Jira response into a short message that never echoes credentials. */
function describeJiraError(status: number, json: unknown): Error {
  const messages = isObj(json) && Array.isArray(json['errorMessages']) ? json['errorMessages'] : []
  const first = messages.find((m): m is string => typeof m === 'string' && m.trim() !== '')
  return new Error(first ? `Jira API error: ${first}` : `Jira API returned status ${status}`)
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchJiraItems(ctx: AdapterCtx, cfg: JiraConfig): Promise<SourceItem[]> {
  const creds = await ctx.credentials('jira')
  const siteUrl = await validateJiraSiteUrl(creds['siteUrl'] ?? '', ctx.allowPrivateHosts)
  const basicAuth = jiraBasicAuth(creds)

  const fields = ['summary', 'description', 'status', 'labels', ...(cfg.repoField ? [cfg.repoField] : [])]
  const items: SourceItem[] = []
  let nextPageToken: string | undefined

  do {
    const params = new URLSearchParams({ jql: cfg.jql, fields: fields.join(','), maxResults: String(JIRA_PAGE_SIZE) })
    if (nextPageToken) params.set('nextPageToken', nextPageToken)
    const url = new URL(`/rest/api/${JIRA_API_VERSION}/search/jql?${params.toString()}`, siteUrl).toString()

    const { status, json } = await jiraRequest(ctx, basicAuth, 'GET', url)
    if (!isSuccess(status)) throw describeJiraError(status, json)
    if (!isObj(json)) throw new Error('Jira API returned an invalid response')

    const issues = Array.isArray(json['issues']) ? json['issues'] : []
    for (const raw of issues) {
      if (items.length >= MAX_ITEMS) break
      if (!isObj(raw)) continue
      const issueFields = isObj(raw['fields']) ? raw['fields'] : {}
      const key = typeof raw['key'] === 'string' ? raw['key'] : ''
      if (!key) continue
      const statusField = issueFields['status']
      const repoFieldValue = cfg.repoField ? issueFields[cfg.repoField] : undefined
      const labelsRaw = issueFields['labels']

      items.push({
        externalId: key,
        title: typeof issueFields['summary'] === 'string' ? issueFields['summary'] : '',
        body: flattenAdf(issueFields['description']),
        url: new URL(`/browse/${encodeURIComponent(key)}`, siteUrl).toString(),
        state: isObj(statusField) && typeof statusField['name'] === 'string' ? statusField['name'] : '',
        labels: Array.isArray(labelsRaw) ? labelsRaw.filter((l): l is string => typeof l === 'string') : [],
        repoUrl: typeof repoFieldValue === 'string' ? repoFieldValue : null,
        position: items.length,
      })
    }

    nextPageToken = typeof json['nextPageToken'] === 'string' ? json['nextPageToken'] : undefined
    if (issues.length === 0) break
  } while (nextPageToken && items.length < MAX_ITEMS)

  return items
}

// ── Write ────────────────────────────────────────────────────────────────────

async function currentIssueStatus(ctx: AdapterCtx, basicAuth: string, siteUrl: URL, key: string): Promise<string> {
  const url = new URL(`/rest/api/${JIRA_API_VERSION}/issue/${encodeURIComponent(key)}?fields=status`, siteUrl).toString()
  const { status, json } = await jiraRequest(ctx, basicAuth, 'GET', url)
  if (!isSuccess(status)) throw describeJiraError(status, json)
  const fields = isObj(json) && isObj(json['fields']) ? json['fields'] : {}
  const current = fields['status']
  return isObj(current) && typeof current['name'] === 'string' ? current['name'] : ''
}

/** Finds the transition whose target (or own) name matches `value`, case-insensitively. */
async function findTransitionId(ctx: AdapterCtx, basicAuth: string, siteUrl: URL, key: string, value: string): Promise<string | null> {
  const url = new URL(`/rest/api/${JIRA_API_VERSION}/issue/${encodeURIComponent(key)}/transitions`, siteUrl).toString()
  const { status, json } = await jiraRequest(ctx, basicAuth, 'GET', url)
  if (!isSuccess(status)) throw describeJiraError(status, json)
  const transitions = isObj(json) && Array.isArray(json['transitions']) ? json['transitions'] : []

  for (const t of transitions) {
    if (!isObj(t) || typeof t['id'] !== 'string') continue
    const to = isObj(t['to']) ? t['to'] : undefined
    const toName = to && typeof to['name'] === 'string' ? to['name'] : undefined
    const name = toName ?? (typeof t['name'] === 'string' ? t['name'] : undefined)
    if (name && name.toLowerCase() === value.toLowerCase()) return t['id']
  }
  return null
}

async function writeJiraStatus(
  ctx: AdapterCtx,
  cfg: JiraConfig,
  item: { externalId: string; title: string; url: string | null },
  w: StatusWrite,
): Promise<void> {
  const creds = await ctx.credentials('jira')
  const siteUrl = await validateJiraSiteUrl(creds['siteUrl'] ?? '', ctx.allowPrivateHosts)
  const basicAuth = jiraBasicAuth(creds)
  const key = item.externalId

  const current = await currentIssueStatus(ctx, basicAuth, siteUrl, key)
  if (current.toLowerCase() !== w.value.toLowerCase()) {
    const transitionId = await findTransitionId(ctx, basicAuth, siteUrl, key, w.value)
    if (transitionId === null) throw new Error(`No transition to '${w.value}' from '${current}'`)

    const url = new URL(`/rest/api/${JIRA_API_VERSION}/issue/${encodeURIComponent(key)}/transitions`, siteUrl).toString()
    const { status, json } = await jiraRequest(ctx, basicAuth, 'POST', url, { transition: { id: transitionId } })
    if (!isSuccess(status)) throw describeJiraError(status, json)
  }

  if (w.comment) {
    const url = new URL(`/rest/api/${JIRA_API_VERSION}/issue/${encodeURIComponent(key)}/comment`, siteUrl).toString()
    const { status, json } = await jiraRequest(ctx, basicAuth, 'POST', url, { body: textToAdfDoc(w.comment) })
    if (!isSuccess(status)) throw describeJiraError(status, json)
  }
}

export const jiraAdapter: SourceAdapter<JiraConfig> = {
  kind: 'jira',
  integration: 'jira',
  parseConfig: parseJiraConfig,
  fetch: fetchJiraItems,
  write: writeJiraStatus,
}
