// ─────────────────────────────────────────────────────────────────────────────
// Azure Boards action: query work items with WIQL, then fetch their fields.
//
// Azure DevOps REST API (learn.microsoft.com/rest/api/azure/devops/wit):
//   POST {org}/{project}/_apis/wit/wiql?api-version=7.1&$top=N           { query } → { workItems: [{ id }] }
//   POST {org}/_apis/wit/workitemsbatch?api-version=7.1                 { ids, fields } → { value: [{ id, fields }] }
// Auth: HTTP Basic, empty username and the PAT as password (see
// integrations/azureDevops.ts). ADO sometimes answers an invalid PAT with a
// 203 (or a 2xx) HTML sign-in page instead of an error status — the same
// signal integrations/providers.ts checks for when testing the connection.
// ─────────────────────────────────────────────────────────────────────────────

import { getIntegrationCredentials } from '../repos/integrations.js'
import { ADO_API_VERSION, adoAuthHeader, adoBaseUrl, isValidAdoOrganization } from '../integrations/azureDevops.js'
import type { FetchFn } from '../integrations/providers.js'
import type { ActionConfig } from './spec.js'
import type { StepContext, StepResult } from './types.js'

const DEFAULT_WIQL =
  "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] NOT IN ('Closed', 'Done', 'Removed') ORDER BY [System.ChangedDate] DESC"

interface WiqlResponse {
  workItems?: Array<{ id: number }>
}

interface WorkItemBatchResponse {
  value?: Array<{
    id: number
    fields?: Record<string, unknown>
  }>
}

export interface BoardsWorkItem {
  id: number
  title: string
  state: string
  type: string
  assignedTo: string | null
  tags: string[]
  url: string
}

function fail(message: string): StepResult {
  return { status: 'failed', error: message }
}

export async function runAzureBoardsAction(
  ctx: StepContext,
  cfg: Extract<ActionConfig, { type: 'azure-boards' }>,
  opts: { fetchImpl?: FetchFn } = {},
): Promise<StepResult> {
  const creds = await ctx.app.db.org(ctx.org.id, (q) => getIntegrationCredentials(q, ctx.app.box, ctx.org.id, 'azure-devops'))
  if (!creds['pat'] || !creds['organization']) {
    return fail('The Azure DevOps integration is not connected (Integrations -> Azure DevOps)')
  }
  ctx.addSecret(creds['pat'])
  const org = creds['organization']
  if (!isValidAdoOrganization(org)) {
    return fail('The Azure DevOps organization in the integration is not valid')
  }

  const fetchImpl = opts.fetchImpl ?? (fetch as FetchFn)
  const limit = cfg.limit ?? 50
  const query = cfg.query?.trim() || DEFAULT_WIQL

  const call = async <T>(what: 'query' | 'work item fetch', path: string, body: unknown): Promise<T | StepResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const onAbort = () => controller.abort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetchImpl(path, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: adoAuthHeader(creds['pat']!), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 203) return fail('Azure DevOps did not accept the token (sign-in page returned)')
      const text = await res.text()
      let data: unknown = null
      let parseFailed = false
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        parseFailed = true
      }
      if (res.ok && parseFailed) return fail('Azure DevOps did not accept the token (sign-in page returned)')
      if (!res.ok) {
        const msg = data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string' ? `: ${(data as { message: string }).message.slice(0, 300)}` : ''
        return fail(`Azure DevOps ${what} failed (HTTP ${res.status})${msg}`)
      }
      return data as T
    } catch (err) {
      if (ctx.signal.aborted) throw err
      if (err instanceof Error && err.name === 'AbortError') return fail('Azure DevOps did not answer within 30s')
      return fail('Could not reach Azure DevOps')
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
    }
  }

  const wiqlUrl = `${adoBaseUrl(org)}/${encodeURIComponent(cfg.project)}/_apis/wit/wiql?api-version=${ADO_API_VERSION}&$top=${limit}`
  const wiqlResult = await call<WiqlResponse>('query', wiqlUrl, { query })
  if (isStepResult(wiqlResult)) return wiqlResult

  const ids = (wiqlResult.workItems ?? []).map((w) => w.id).slice(0, limit)

  const itemsById = new Map<number, { fields?: Record<string, unknown> }>()
  if (ids.length) {
    const batchUrl = `${adoBaseUrl(org)}/${encodeURIComponent(cfg.project)}/_apis/wit/workitemsbatch?api-version=${ADO_API_VERSION}`
    const batchResult = await call<WorkItemBatchResponse>('work item fetch', batchUrl, {
      ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.Tags'],
    })
    if (isStepResult(batchResult)) return batchResult
    for (const w of batchResult.value ?? []) itemsById.set(w.id, w)
  }

  const items: BoardsWorkItem[] = []
  for (const id of ids) {
    const w = itemsById.get(id)
    if (!w) continue
    const fields = w.fields ?? {}
    const assignedTo = fields['System.AssignedTo'] as { displayName?: string } | undefined
    const tagsRaw = typeof fields['System.Tags'] === 'string' ? (fields['System.Tags'] as string) : ''
    items.push({
      id,
      title: typeof fields['System.Title'] === 'string' ? (fields['System.Title'] as string) : '',
      state: typeof fields['System.State'] === 'string' ? (fields['System.State'] as string) : '',
      type: typeof fields['System.WorkItemType'] === 'string' ? (fields['System.WorkItemType'] as string) : '',
      assignedTo: assignedTo?.displayName ?? null,
      tags: tagsRaw
        .split(';')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      url: `${adoBaseUrl(org)}/${encodeURIComponent(cfg.project)}/_workitems/edit/${id}`,
    })
  }

  const summary = items.length
    ? items.map((i) => `- #${i.id} [${i.type}] ${i.title} (${i.state}${i.assignedTo ? `, ${i.assignedTo}` : ''}) ${i.url}`).join('\n')
    : 'No work items matched.'

  await ctx.log(`Azure Boards: ${items.length} work item(s) from ${cfg.project}`)
  return { status: 'succeeded', output: { count: items.length, items, summary } }
}

function isStepResult(v: unknown): v is StepResult {
  return !!v && typeof v === 'object' && 'status' in v
}
