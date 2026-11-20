// ─────────────────────────────────────────────────────────────────────────────
// Repo source adapter: a GitHub repo of spec files acts as a backlog. Reads
// files matching a glob as items; writes Routini's item state back by
// opening (or updating) a pull request from a dedicated status branch, never
// the tracking branch itself. Contract: docs/work-intake-backlog.md section 6.
//
// All network calls go through `ctx.fetch` against the fixed host
// api.github.com; credentials come from `ctx.credentials('github')` (field
// `token`), never from caller-supplied input.
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import { createPullRequest, parseGithubRepo } from '../integrations/github.js'
import { globToRegExp } from './glob.js'
import type { AdapterCtx, SourceAdapter, SourceItem, StatusWrite } from './types.js'

const GITHUB_API_URL = 'https://api.github.com'
const MAX_MATCHING_FILES = 200
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/
const FIELD_NAME_RE = /^[A-Za-z0-9_-]{1,60}$/

export type RepoStatus = { kind: 'frontmatter'; key: string } | { kind: 'line'; prefix: string }

export interface RepoConfig {
  repoUrl: string
  owner: string
  repo: string
  branch: string
  glob: string
  status: RepoStatus
  repoKey?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// ── Config ───────────────────────────────────────────────────────────────────

/** Validates a repo source's config; throws SpecError naming the exact field. */
export function parseRepoConfig(raw: unknown): RepoConfig {
  if (!isObj(raw)) throw new SpecError('config must be an object')

  const repoUrlRaw = raw['repoUrl']
  if (typeof repoUrlRaw !== 'string') throw new SpecError('config.repoUrl must be a string')
  const parsed = parseGithubRepo(repoUrlRaw)
  if (!parsed) throw new SpecError('repoUrl must be a https://github.com/<owner>/<repo> URL')

  const branchRaw = raw['branch'] === undefined ? 'main' : raw['branch']
  if (typeof branchRaw !== 'string' || !BRANCH_RE.test(branchRaw)) {
    throw new SpecError('config.branch must match ^[A-Za-z0-9._/-]{1,200}$')
  }
  if (branchRaw.includes('..')) throw new SpecError('branch must not contain ..')

  const globRaw = raw['glob']
  if (typeof globRaw !== 'string' || globRaw.trim() === '' || globRaw.length > 300) {
    throw new SpecError('config.glob must be a non-empty string of at most 300 characters')
  }
  if (globRaw.includes('..')) throw new SpecError('glob must not contain ..')

  const status = parseStatusConfig(raw['status'])

  let repoKey: string | undefined
  if (raw['repoKey'] !== undefined) {
    if (typeof raw['repoKey'] !== 'string' || !FIELD_NAME_RE.test(raw['repoKey'])) {
      throw new SpecError('config.repoKey must be a short alphanumeric field name')
    }
    repoKey = raw['repoKey']
  }

  return {
    repoUrl: repoUrlRaw,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: branchRaw,
    glob: globRaw,
    status,
    ...(repoKey !== undefined ? { repoKey } : {}),
  }
}

function parseStatusConfig(raw: unknown): RepoStatus {
  if (!isObj(raw)) throw new SpecError('config.status must be an object')
  if (raw['kind'] === 'frontmatter') {
    const key = raw['key']
    if (typeof key !== 'string' || !FIELD_NAME_RE.test(key)) {
      throw new SpecError('config.status.key must be a short alphanumeric field name')
    }
    return { kind: 'frontmatter', key }
  }
  if (raw['kind'] === 'line') {
    const prefix = raw['prefix']
    if (typeof prefix !== 'string' || prefix.trim() === '' || prefix.length > 60) {
      throw new SpecError('config.status.prefix must be a non-empty string of at most 60 characters')
    }
    return { kind: 'line', prefix }
  }
  throw new SpecError('config.status.kind must be "frontmatter" or "line"')
}

// ── Front matter / line helpers ─────────────────────────────────────────────

interface FrontMatter {
  /** Field values from the leading `---` block; empty when there is none. */
  data: Record<string, string>
  /** True when the file starts with a well-formed `---`...`---` block. */
  present: boolean
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      // fall through to the raw value
    }
  }
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseFrontMatter(lines: readonly string[]): FrontMatter {
  if (lines[0] !== '---') return { data: {}, present: false }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { data: {}, present: false }
  const data: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!)
    if (m) data[m[1]!] = unquote(m[2]!)
  }
  return { data, present: true }
}

function fileNameOf(path: string): string {
  const segments = path.split('/')
  return segments[segments.length - 1] ?? path
}

export function extractTitle(path: string, lines: readonly string[], frontMatter: FrontMatter): string {
  if (frontMatter.data['title']) return frontMatter.data['title']
  for (const line of lines) {
    const m = /^#\s+(.+)$/.exec(line)
    if (m) return m[1]!.trim()
  }
  return fileNameOf(path)
}

export function extractState(lines: readonly string[], frontMatter: FrontMatter, status: RepoStatus): string {
  if (status.kind === 'frontmatter') return frontMatter.data[status.key] ?? ''
  for (const line of lines) {
    if (line.startsWith(status.prefix)) return line.slice(status.prefix.length).trim()
  }
  return ''
}

function formatFrontMatterValue(value: string): string {
  if (value === '' || /[:#'"\n]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value)
  }
  return value
}

/** Returns `text` with only the status field changed; inserts the field when it was missing. */
export function applyStatus(text: string, status: RepoStatus, value: string): string {
  const lines = text.split('\n')
  if (status.kind === 'line') {
    const idx = lines.findIndex((l) => l.startsWith(status.prefix))
    const newLine = `${status.prefix} ${value}`
    if (idx === -1) {
      lines.unshift(newLine)
    } else {
      lines[idx] = newLine
    }
    return lines.join('\n')
  }

  const newLine = `${status.key}: ${formatFrontMatterValue(value)}`
  if (lines[0] !== '---') {
    return ['---', newLine, '---', ...lines].join('\n')
  }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    // Malformed front matter (no closing delimiter): add a well-formed block on top.
    return ['---', newLine, '---', ...lines].join('\n')
  }
  const keyIdx = lines.slice(1, end).findIndex((l) => new RegExp(`^${status.key}:\\s*`).test(l))
  if (keyIdx === -1) {
    lines.splice(end, 0, newLine)
  } else {
    lines[1 + keyIdx] = newLine
  }
  return lines.join('\n')
}

// ── GitHub REST helpers ──────────────────────────────────────────────────────

/** URL-encodes each path segment individually, preserving `/` as the directory separator. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

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
    signal: ctx.signal,
  })
  const json = await parseJsonBody(res)
  return { status: res.status, json }
}

function describeGithubError(method: string, path: string, status: number, json: unknown): Error {
  const detail = isObj(json) && typeof json['message'] === 'string' ? `: ${json['message']}` : ''
  return new Error(`GitHub API ${method} ${path} failed (HTTP ${status}${detail})`)
}

async function listTree(ctx: AdapterCtx, token: string, owner: string, repo: string, branch: string): Promise<string[]> {
  const path = `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  const { status, json } = await githubRequest(ctx, token, 'GET', path)
  if (status !== 200) throw describeGithubError('GET', path, status, json)
  const tree = isObj(json) && Array.isArray(json['tree']) ? json['tree'] : []
  const paths: string[] = []
  for (const entry of tree) {
    if (isObj(entry) && entry['type'] === 'blob' && typeof entry['path'] === 'string') paths.push(entry['path'])
  }
  return paths
}

interface RepoFile {
  text: string
  sha: string
}

async function getFile(
  ctx: AdapterCtx,
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<RepoFile> {
  const reqPath = `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
  const { status, json } = await githubRequest(ctx, token, 'GET', reqPath)
  if (status !== 200 || !isObj(json) || typeof json['content'] !== 'string' || typeof json['sha'] !== 'string') {
    throw describeGithubError('GET', reqPath, status, json)
  }
  const text = Buffer.from(json['content'].replace(/\n/g, ''), 'base64').toString('utf8')
  return { text, sha: json['sha'] }
}

async function putFile(
  ctx: AdapterCtx,
  token: string,
  owner: string,
  repo: string,
  path: string,
  text: string,
  sha: string,
  branch: string,
  message: string,
): Promise<void> {
  const reqPath = `/repos/${owner}/${repo}/contents/${encodePath(path)}`
  const content = Buffer.from(text, 'utf8').toString('base64')
  const { status, json } = await githubRequest(ctx, token, 'PUT', reqPath, { message, content, sha, branch })
  if (status !== 200 && status !== 201) throw describeGithubError('PUT', reqPath, status, json)
}

async function getRefSha(ctx: AdapterCtx, token: string, owner: string, repo: string, branch: string): Promise<string | null> {
  const path = `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
  const { status, json } = await githubRequest(ctx, token, 'GET', path)
  if (status === 404) return null
  if (status !== 200) throw describeGithubError('GET', path, status, json)
  const object = isObj(json) ? json['object'] : undefined
  if (!isObj(object) || typeof object['sha'] !== 'string') throw new Error(`GitHub API GET ${path} returned no sha`)
  return object['sha']
}

async function createRef(ctx: AdapterCtx, token: string, owner: string, repo: string, branch: string, sha: string): Promise<void> {
  const path = `/repos/${owner}/${repo}/git/refs`
  const { status, json } = await githubRequest(ctx, token, 'POST', path, { ref: `refs/heads/${branch}`, sha })
  if (status !== 201) throw describeGithubError('POST', path, status, json)
}

interface OpenPr {
  number: number
  url: string
}

async function findOpenPr(ctx: AdapterCtx, token: string, owner: string, repo: string, branch: string): Promise<OpenPr | null> {
  const path = `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`
  const { status, json } = await githubRequest(ctx, token, 'GET', path)
  if (status !== 200) throw describeGithubError('GET', path, status, json)
  if (!Array.isArray(json) || json.length === 0) return null
  const first = json[0]
  if (!isObj(first) || typeof first['number'] !== 'number' || typeof first['html_url'] !== 'string') return null
  return { number: first['number'], url: first['html_url'] }
}

/** `routini/status/<slug of path>`: lowercase, non-alphanumerics to `-`, at most 80 characters. */
export function statusBranchName(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return `routini/status/${slug}`
}

// ── Adapter ───────────────────────────────────────────────────────────────────

async function fetchRepoItems(ctx: AdapterCtx, cfg: RepoConfig): Promise<SourceItem[]> {
  const creds = await ctx.credentials('github')
  const token = creds['token'] ?? ''

  const allPaths = await listTree(ctx, token, cfg.owner, cfg.repo, cfg.branch)
  const matcher = globToRegExp(cfg.glob)
  const matches = allPaths.filter((p) => matcher.test(p))
  if (matches.length > MAX_MATCHING_FILES) {
    throw new Error(`Narrow the glob: ${matches.length} files match, the limit is ${MAX_MATCHING_FILES}`)
  }

  const items: SourceItem[] = []
  for (const path of matches) {
    const file = await getFile(ctx, token, cfg.owner, cfg.repo, path, cfg.branch)
    const lines = file.text.split('\n')
    const frontMatter = parseFrontMatter(lines)
    items.push({
      externalId: path,
      title: extractTitle(path, lines, frontMatter),
      body: file.text,
      url: `https://github.com/${cfg.owner}/${cfg.repo}/blob/${cfg.branch}/${path}`,
      state: extractState(lines, frontMatter, cfg.status),
      labels: [],
      repoUrl: cfg.repoKey ? frontMatter.data[cfg.repoKey] ?? null : null,
    })
  }
  return items
}

async function writeRepoStatus(
  ctx: AdapterCtx,
  cfg: RepoConfig,
  item: { externalId: string; title: string; url: string | null },
  w: StatusWrite,
): Promise<void> {
  const creds = await ctx.credentials('github')
  const token = creds['token'] ?? ''
  const { owner, repo } = cfg
  const branch = statusBranchName(item.externalId)

  let pr = await findOpenPr(ctx, token, owner, repo, branch)
  if (!pr) {
    const existingSha = await getRefSha(ctx, token, owner, repo, branch)
    if (existingSha === null) {
      const baseSha = await getRefSha(ctx, token, owner, repo, cfg.branch)
      if (baseSha === null) throw new Error(`Branch '${cfg.branch}' was not found in ${owner}/${repo}`)
      await createRef(ctx, token, owner, repo, branch, baseSha)
    }
  }

  // Read and write on the status branch only — never on the tracking branch.
  const file = await getFile(ctx, token, owner, repo, item.externalId, branch)
  const updated = applyStatus(file.text, cfg.status, w.value)
  await putFile(ctx, token, owner, repo, item.externalId, updated, file.sha, branch, `Routini: set status to "${w.value}"`)

  if (!pr) {
    const created = await createPullRequest(
      token,
      {
        owner,
        repo,
        head: branch,
        base: cfg.branch,
        title: `Routini: ${item.title} -> ${w.value}`,
        body: w.comment ?? '',
      },
      ctx.fetch,
    )
    pr = { number: created.number, url: created.url }
  }
}

export const repoAdapter: SourceAdapter<RepoConfig> = {
  kind: 'repo',
  integration: 'github',
  parseConfig: parseRepoConfig,
  fetch: fetchRepoItems,
  write: writeRepoStatus,
}
