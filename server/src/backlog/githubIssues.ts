// ─────────────────────────────────────────────────────────────────────────────
// GitHub Issues backlog source. Issues (not pull requests) in a repo act as
// backlog items; the state comes from an issue label prefixed with
// `statusPrefix` (default "status:"), falling back to the issue's own
// open/closed state. Writing `open`/`closed` toggles the issue itself;
// writing anything else swaps the prefixed label. Contract:
// docs/work-intake-backlog.md section 6b "githubIssues.ts".
//
// All network calls go through `ctx.fetch` against the fixed host
// api.github.com; credentials come from `ctx.credentials('github')` (field
// `token`), never from caller-supplied input.
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import { parseGithubRepo } from '../integrations/github.js'
import type { AdapterCtx, SourceAdapter, SourceItem, StatusWrite } from './types.js'

const GITHUB_API_URL = 'https://api.github.com'
const PER_PAGE = 100
const MAX_ITEMS = 500
const MAX_LABELS = 20
const MAX_LABEL_LENGTH = 60
const MAX_STATUS_PREFIX_LENGTH = 60
const DEFAULT_STATUS_PREFIX = 'status:'

export interface GithubIssuesConfig {
  repoUrl: string
  owner: string
  repo: string
  labels?: string[]
  statusPrefix: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// ── Config ───────────────────────────────────────────────────────────────────

/** Validates a GitHub Issues source's config; throws SpecError naming the exact field. */
export function parseGithubIssuesConfig(raw: unknown): GithubIssuesConfig {
  if (!isObj(raw)) throw new SpecError('config must be an object')

  const repoUrlRaw = raw['repoUrl']
  if (typeof repoUrlRaw !== 'string') throw new SpecError('config.repoUrl must be a string')
  const parsed = parseGithubRepo(repoUrlRaw)
  if (!parsed) throw new SpecError('repoUrl must be a https://github.com/<owner>/<repo> URL')

  let labels: string[] | undefined
  if (raw['labels'] !== undefined) {
    const rawLabels = raw['labels']
    const valid =
      Array.isArray(rawLabels) &&
      rawLabels.length <= MAX_LABELS &&
      rawLabels.every((l) => typeof l === 'string' && l.trim() !== '' && l.length <= MAX_LABEL_LENGTH)
    if (!valid) {
      throw new SpecError(`config.labels must be a list of at most ${MAX_LABELS} non-empty strings of at most ${MAX_LABEL_LENGTH} characters`)
    }
    labels = rawLabels as string[]
  }

  let statusPrefix = DEFAULT_STATUS_PREFIX
  if (raw['statusPrefix'] !== undefined) {
    const rawPrefix = raw['statusPrefix']
    if (typeof rawPrefix !== 'string' || rawPrefix.trim() === '' || rawPrefix.length > MAX_STATUS_PREFIX_LENGTH) {
      throw new SpecError(`config.statusPrefix must be a non-empty string of at most ${MAX_STATUS_PREFIX_LENGTH} characters`)
    }
    statusPrefix = rawPrefix
  }

  return {
    repoUrl: repoUrlRaw,
    owner: parsed.owner,
    repo: parsed.repo,
    statusPrefix,
    ...(labels !== undefined ? { labels } : {}),
  }
}

// ── GitHub REST helpers ──────────────────────────────────────────────────────

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Routini/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

async function githubRequest(
  ctx: AdapterCtx,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await ctx.fetch(`${GITHUB_API_URL}${path}`, {
    method,
    headers: githubHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: ctx.signal,
  })
  const json = await parseJsonBody(res)
  return { status: res.status, json }
}

/** A short message naming the failed request, without the token or any other credential. */
function describeGithubError(method: string, path: string, status: number, json: unknown): Error {
  const detail = isObj(json) && typeof json['message'] === 'string' ? `: ${json['message']}` : ''
  return new Error(`GitHub API ${method} ${path} failed (HTTP ${status}${detail})`)
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const l of raw) {
    if (typeof l === 'string') names.push(l)
    else if (isObj(l) && typeof l['name'] === 'string') names.push(l['name'])
  }
  return names
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/** The item's state: the rest of the first label starting with `statusPrefix`, else open/closed. */
function stateFromLabels(allLabels: string[], rawState: unknown, statusPrefix: string): { state: string; labels: string[] } {
  const prefixed = allLabels.find((l) => l.startsWith(statusPrefix))
  if (prefixed !== undefined) {
    return { state: prefixed.slice(statusPrefix.length).trim(), labels: allLabels.filter((l) => l !== prefixed) }
  }
  return { state: rawState === 'closed' ? 'closed' : 'open', labels: allLabels }
}

function toSourceItem(entry: Record<string, unknown>, statusPrefix: string, position: number): SourceItem {
  const { state, labels } = stateFromLabels(labelNames(entry['labels']), entry['state'], statusPrefix)
  return {
    externalId: String(entry['number'] ?? ''),
    title: typeof entry['title'] === 'string' ? entry['title'] : '',
    body: typeof entry['body'] === 'string' ? entry['body'] : '',
    url: typeof entry['html_url'] === 'string' ? entry['html_url'] : null,
    state,
    labels,
    position,
  }
}

async function fetchGithubIssues(ctx: AdapterCtx, cfg: GithubIssuesConfig): Promise<SourceItem[]> {
  const creds = await ctx.credentials('github')
  const token = creds['token'] ?? ''
  const labelsQuery = cfg.labels && cfg.labels.length > 0 ? `&labels=${encodeURIComponent(cfg.labels.join(','))}` : ''

  const items: SourceItem[] = []
  for (let page = 1; items.length < MAX_ITEMS; page++) {
    const path = `/repos/${cfg.owner}/${cfg.repo}/issues?state=all&per_page=${PER_PAGE}&page=${page}${labelsQuery}`
    const { status, json } = await githubRequest(ctx, token, 'GET', path)
    if (status !== 200) throw describeGithubError('GET', path, status, json)
    const raw = Array.isArray(json) ? json : []

    for (const entry of raw) {
      if (!isObj(entry)) continue
      if ('pull_request' in entry) continue // skip pull requests: the issues endpoint also lists them
      if (typeof entry['number'] !== 'number') continue
      items.push(toSourceItem(entry, cfg.statusPrefix, items.length))
      if (items.length >= MAX_ITEMS) break
    }
    if (raw.length < PER_PAGE) break // short page: no more to fetch
  }
  return items
}

// ── Write ─────────────────────────────────────────────────────────────────────

async function writeOpenClosed(ctx: AdapterCtx, token: string, cfg: GithubIssuesConfig, number: string, value: string): Promise<void> {
  const path = `/repos/${cfg.owner}/${cfg.repo}/issues/${number}`
  const { status, json } = await githubRequest(ctx, token, 'PATCH', path, { state: value.toLowerCase() })
  if (status !== 200) throw describeGithubError('PATCH', path, status, json)
}

/** Removes every label starting with `statusPrefix`, then adds the one label for the new value. */
async function swapStatusLabel(ctx: AdapterCtx, token: string, cfg: GithubIssuesConfig, number: string, value: string): Promise<void> {
  const getPath = `/repos/${cfg.owner}/${cfg.repo}/issues/${number}`
  const { status: getStatus, json: getJson } = await githubRequest(ctx, token, 'GET', getPath)
  if (getStatus !== 200) throw describeGithubError('GET', getPath, getStatus, getJson)
  const current = labelNames(isObj(getJson) ? getJson['labels'] : undefined)
  const toRemove = current.filter((l) => l.startsWith(cfg.statusPrefix))

  for (const label of toRemove) {
    const delPath = `/repos/${cfg.owner}/${cfg.repo}/issues/${number}/labels/${encodeURIComponent(label)}`
    const { status, json } = await githubRequest(ctx, token, 'DELETE', delPath)
    if (status !== 200 && status !== 404) throw describeGithubError('DELETE', delPath, status, json)
  }

  const addPath = `/repos/${cfg.owner}/${cfg.repo}/issues/${number}/labels`
  const { status, json } = await githubRequest(ctx, token, 'POST', addPath, { labels: [`${cfg.statusPrefix}${value}`] })
  if (status !== 200) throw describeGithubError('POST', addPath, status, json)
}

async function writeGithubIssueStatus(
  ctx: AdapterCtx,
  cfg: GithubIssuesConfig,
  item: { externalId: string; title: string; url: string | null },
  w: StatusWrite,
): Promise<void> {
  const creds = await ctx.credentials('github')
  const token = creds['token'] ?? ''
  const lower = w.value.toLowerCase()

  if (lower === 'open' || lower === 'closed') {
    await writeOpenClosed(ctx, token, cfg, item.externalId, lower)
  } else {
    await swapStatusLabel(ctx, token, cfg, item.externalId, w.value)
  }

  if (w.comment) {
    const path = `/repos/${cfg.owner}/${cfg.repo}/issues/${item.externalId}/comments`
    const { status, json } = await githubRequest(ctx, token, 'POST', path, { body: w.comment })
    if (status !== 201) throw describeGithubError('POST', path, status, json)
  }
}

export const githubIssuesAdapter: SourceAdapter<GithubIssuesConfig> = {
  kind: 'github-issues',
  integration: 'github',
  parseConfig: parseGithubIssuesConfig,
  fetch: fetchGithubIssues,
  write: writeGithubIssueStatus,
}
