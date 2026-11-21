// ─────────────────────────────────────────────────────────────────────────────
// Azure Boards backlog source. Reads a project's work items (via WIQL, then
// workitemsbatch) as backlog items and writes Routini's item state back onto
// System.State (and optionally a comment). Contract:
// docs/work-intake-backlog.md section 6b.
//
// All network calls go through `ctx.fetch` against the org's Azure DevOps
// Services REST API (integrations/azureDevops.ts); credentials come from
// `ctx.credentials('azure-devops')` (fields `organization`, `pat`), never
// from caller-supplied input. ADO sometimes answers an invalid PAT with a
// 2xx HTML sign-in page instead of a JSON body — the same signal
// engine/boards.ts checks for when running the azure-boards action.
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import { ADO_API_VERSION, adoAuthHeader, adoBaseUrl } from '../integrations/azureDevops.js'
import type { AdapterCtx, SourceAdapter, SourceItem, StatusWrite } from './types.js'

/** Same default as the azure-boards action (engine/boards.ts): everything not closed out. */
const DEFAULT_WIQL =
  "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] NOT IN ('Closed', 'Done', 'Removed') ORDER BY [System.ChangedDate] DESC"

/** ADO work item project name rule — the same check the azure-boards action applies (engine/spec.ts). */
const PROJECT_RE = /^[^/\\?#%*:|"<>.\x00-\x1f\x7f][^/\\?#%*:|"<>\x00-\x1f\x7f]*$/

/** Comment creation is still on this preview version in the ADO REST API. */
const ADO_COMMENTS_API_VERSION = '7.1-preview.4'

/** Fetch at most this many work items per sync; workitemsbatch is paged in chunks of this size. */
const MAX_ITEMS = 500
const BATCH_SIZE = 200

export interface AzureBoardsConfig {
  project: string
  wiql?: string
  repoField?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseProject(raw: unknown): string {
  if (typeof raw !== 'string') throw new SpecError('config.project must be a string')
  if (raw.trim() === '') throw new SpecError('config.project must not be empty')
  if (raw.length > 64) throw new SpecError('config.project must be at most 64 characters')
  if (!PROJECT_RE.test(raw)) throw new SpecError('config.project is not a valid Azure DevOps project name')
  return raw
}

function parseWiql(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new SpecError('config.wiql must be a string')
  if (raw.trim() === '') throw new SpecError('config.wiql must not be empty')
  if (raw.length > 2000) throw new SpecError('config.wiql must be at most 2000 characters')
  return raw
}

function parseRepoField(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 200) {
    throw new SpecError('config.repoField must be a non-empty string')
  }
  return raw
}

/** Validates an Azure Boards source's config; throws SpecError naming the exact field. */
export function parseAzureBoardsConfig(raw: unknown): AzureBoardsConfig {
  if (!isObj(raw)) throw new SpecError('config must be an object')

  const cfg: AzureBoardsConfig = { project: parseProject(raw['project']) }
  const wiql = parseWiql(raw['wiql'])
  if (wiql !== undefined) cfg.wiql = wiql
  const repoField = parseRepoField(raw['repoField'])
  if (repoField !== undefined) cfg.repoField = repoField
  return cfg
}

/**
 * Strips HTML tags and decodes the handful of entities ADO's rich-text fields
 * commonly use. Block ends (`</p>`, `</div>`, `</li>`, headings) and `<br>`
 * become line breaks, so the plan step sees the description's paragraphs.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Work item comments are HTML: escape the text and keep its line breaks. */
function commentHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

/**
 * Sends one Azure DevOps REST request, surfacing ADO's "HTML sign-in page
 * instead of JSON" failure mode (an invalid PAT can still answer 2xx) as a
 * clear error, and tracker error bodies as a short message without
 * credentials.
 */
async function adoRequest<T>(
  ctx: AdapterCtx,
  pat: string,
  method: string,
  url: string,
  body: unknown,
  contentType = 'application/json',
): Promise<T> {
  const res = await ctx.fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      Authorization: adoAuthHeader(pat),
      'Content-Type': contentType,
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
  })
  if (res.status === 203) throw new Error('Azure DevOps did not accept the token (sign-in page returned)')

  const text = await res.text()
  let data: unknown = null
  let parseFailed = false
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    parseFailed = true
  }
  // An empty or non-object 2xx body is ADO's sign-in page, not an API answer.
  if (res.ok && (parseFailed || !isObj(data))) {
    throw new Error('Azure DevOps did not accept the token (sign-in page returned)')
  }
  if (!res.ok) {
    const msg = isObj(data) && typeof data['message'] === 'string' ? `: ${data['message'].slice(0, 300)}` : ''
    throw new Error(`Azure DevOps request failed (HTTP ${res.status})${msg}`)
  }
  return data as T
}

interface WiqlResponse {
  workItems?: Array<{ id: number }>
}

interface WorkItemsBatchResponse {
  value?: Array<{ id: number; fields?: Record<string, unknown> }>
}

async function fetchAzureBoardsItems(ctx: AdapterCtx, cfg: AzureBoardsConfig): Promise<SourceItem[]> {
  const creds = await ctx.credentials('azure-devops')
  const pat = creds['pat'] ?? ''
  const org = creds['organization'] ?? ''
  const base = adoBaseUrl(org)
  const projectPath = encodeURIComponent(cfg.project)

  const wiqlUrl = `${base}/${projectPath}/_apis/wit/wiql?api-version=${ADO_API_VERSION}&$top=${MAX_ITEMS}`
  const wiqlResult = await adoRequest<WiqlResponse>(ctx, pat, 'POST', wiqlUrl, { query: cfg.wiql ?? DEFAULT_WIQL })
  const ids = (wiqlResult.workItems ?? []).map((w) => w.id).slice(0, MAX_ITEMS)

  const fields = ['System.Title', 'System.Description', 'System.State', 'System.Tags']
  if (cfg.repoField) fields.push(cfg.repoField)

  const fieldsById = new Map<number, Record<string, unknown>>()
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE)
    const batchUrl = `${base}/${projectPath}/_apis/wit/workitemsbatch?api-version=${ADO_API_VERSION}`
    const batchResult = await adoRequest<WorkItemsBatchResponse>(ctx, pat, 'POST', batchUrl, { ids: chunk, fields })
    for (const w of batchResult.value ?? []) fieldsById.set(w.id, w.fields ?? {})
  }

  const items: SourceItem[] = []
  for (const id of ids) {
    const f = fieldsById.get(id)
    if (!f) continue
    const description = typeof f['System.Description'] === 'string' ? (f['System.Description'] as string) : ''
    const tagsRaw = typeof f['System.Tags'] === 'string' ? (f['System.Tags'] as string) : ''
    const repoUrl = cfg.repoField && typeof f[cfg.repoField] === 'string' ? (f[cfg.repoField] as string) : null

    items.push({
      externalId: String(id),
      title: typeof f['System.Title'] === 'string' ? (f['System.Title'] as string) : '',
      body: stripHtml(description),
      url: `${base}/${projectPath}/_workitems/edit/${id}`,
      state: typeof f['System.State'] === 'string' ? (f['System.State'] as string) : '',
      labels: tagsRaw
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      repoUrl,
      position: items.length,
    })
  }
  return items
}

async function writeAzureBoardsStatus(
  ctx: AdapterCtx,
  cfg: AzureBoardsConfig,
  item: { externalId: string; title: string; url: string | null },
  w: StatusWrite,
): Promise<void> {
  const creds = await ctx.credentials('azure-devops')
  const pat = creds['pat'] ?? ''
  const org = creds['organization'] ?? ''
  const base = adoBaseUrl(org)
  const id = encodeURIComponent(item.externalId)

  const patchUrl = `${base}/_apis/wit/workitems/${id}?api-version=${ADO_API_VERSION}`
  await adoRequest(
    ctx,
    pat,
    'PATCH',
    patchUrl,
    [{ op: 'add', path: '/fields/System.State', value: w.value }],
    'application/json-patch+json',
  )

  if (w.comment) {
    const commentUrl = `${base}/${encodeURIComponent(cfg.project)}/_apis/wit/workItems/${id}/comments?api-version=${ADO_COMMENTS_API_VERSION}`
    await adoRequest(ctx, pat, 'POST', commentUrl, { text: commentHtml(w.comment) })
  }
}

export const azureBoardsAdapter: SourceAdapter<AzureBoardsConfig> = {
  kind: 'azure-boards',
  integration: 'azure-devops',
  parseConfig: parseAzureBoardsConfig,
  fetch: fetchAzureBoardsItems,
  write: writeAzureBoardsStatus,
}
