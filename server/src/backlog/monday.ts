// ─────────────────────────────────────────────────────────────────────────────
// monday.com source adapter. Reads a board's items as backlog items and
// writes Routini's item state back onto a status column (and optionally a
// comment). Contract: docs/work-intake-backlog.md section 6.
//
// All network calls go through `ctx.fetch` against the fixed monday GraphQL
// endpoint; credentials come from `ctx.credentials('monday')` (field
// `apiToken`), never from caller-supplied input.
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import type { AdapterCtx, SourceAdapter, SourceItem, StatusWrite } from './types.js'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const MONDAY_API_VERSION = '2024-10'

export interface MondayConfig {
  boardId: string
  groupId?: string
  statusColumnId: string
  repoColumnId?: string
  labelsColumnId?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function optionalString(raw: unknown, path: string, max = 200): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max) {
    throw new SpecError(`${path} must be a non-empty string`)
  }
  return raw
}

/** Validates a monday source's config; throws SpecError naming the exact field. */
export function parseMondayConfig(raw: unknown): MondayConfig {
  if (!isObj(raw)) throw new SpecError('config must be an object')

  const boardId = raw['boardId']
  if (typeof boardId !== 'string' || !/^[0-9]{1,32}$/.test(boardId)) {
    throw new SpecError('config.boardId must be a string of digits')
  }
  const statusColumnId = optionalString(raw['statusColumnId'], 'config.statusColumnId')
  if (statusColumnId === undefined) throw new SpecError('config.statusColumnId must be a non-empty string')

  const cfg: MondayConfig = { boardId, statusColumnId }
  const groupId = optionalString(raw['groupId'], 'config.groupId')
  if (groupId !== undefined) cfg.groupId = groupId
  const repoColumnId = optionalString(raw['repoColumnId'], 'config.repoColumnId')
  if (repoColumnId !== undefined) cfg.repoColumnId = repoColumnId
  const labelsColumnId = optionalString(raw['labelsColumnId'], 'config.labelsColumnId')
  if (labelsColumnId !== undefined) cfg.labelsColumnId = labelsColumnId
  return cfg
}

/** POSTs a GraphQL request to monday.com and returns `data`, surfacing the first GraphQL error (if any) or a transport error. */
async function mondayRequest(
  ctx: AdapterCtx,
  apiToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      authorization: apiToken,
      'api-version': MONDAY_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: ctx.signal,
  })
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new Error(`monday.com API returned an invalid response (HTTP ${res.status})`, { cause: err })
  }
  if (!isObj(json)) throw new Error(`monday.com API returned an invalid response (HTTP ${res.status})`)
  const errors = json['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0]
    const message = isObj(first) && typeof first['message'] === 'string' ? first['message'] : 'monday.com API returned an error'
    throw new Error(message)
  }
  if (!res.ok) throw new Error(`monday.com API returned status ${res.status}`)
  const data = json['data']
  return isObj(data) ? data : {}
}

function columnText(columns: unknown, columnId: string): string | undefined {
  if (!Array.isArray(columns)) return undefined
  const col = columns.find((c) => isObj(c) && c['id'] === columnId)
  return isObj(col) && typeof col['text'] === 'string' ? col['text'] : undefined
}

async function fetchMondayItems(ctx: AdapterCtx, cfg: MondayConfig): Promise<SourceItem[]> {
  const creds = await ctx.credentials('monday')
  const data = await mondayRequest(
    ctx,
    creds['apiToken'] ?? '',
    `query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          items { id name url group { id } column_values { id text } }
        }
      }
    }`,
    { boardId: cfg.boardId },
  )
  const board = Array.isArray(data['boards']) ? data['boards'][0] : undefined
  const itemsPage = isObj(board) ? board['items_page'] : undefined
  const items = isObj(itemsPage) && Array.isArray(itemsPage['items']) ? itemsPage['items'] : []

  const result: SourceItem[] = []
  for (const raw of items) {
    if (!isObj(raw)) continue
    const group = raw['group']
    const groupId = isObj(group) && typeof group['id'] === 'string' ? group['id'] : undefined
    if (cfg.groupId && groupId !== cfg.groupId) continue

    const columns = raw['column_values']
    const labelsText = cfg.labelsColumnId ? columnText(columns, cfg.labelsColumnId) : undefined
    const labels = labelsText
      ? labelsText
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : []

    result.push({
      externalId: String(raw['id'] ?? ''),
      title: typeof raw['name'] === 'string' ? raw['name'] : '',
      body: '',
      url: typeof raw['url'] === 'string' ? raw['url'] : null,
      state: columnText(columns, cfg.statusColumnId) ?? '',
      labels,
      repoUrl: cfg.repoColumnId ? columnText(columns, cfg.repoColumnId) ?? null : null,
    })
  }
  return result
}

async function writeMondayStatus(
  ctx: AdapterCtx,
  cfg: MondayConfig,
  item: { externalId: string; title: string; url: string | null },
  w: StatusWrite,
): Promise<void> {
  const creds = await ctx.credentials('monday')
  const apiToken = creds['apiToken'] ?? ''

  await mondayRequest(
    ctx,
    apiToken,
    `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }`,
    { boardId: cfg.boardId, itemId: item.externalId, columnId: cfg.statusColumnId, value: w.value },
  )

  if (w.comment) {
    await mondayRequest(
      ctx,
      apiToken,
      `mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) { id }
      }`,
      { itemId: item.externalId, body: w.comment },
    )
  }
}

export const mondayAdapter: SourceAdapter<MondayConfig> = {
  kind: 'monday',
  integration: 'monday',
  parseConfig: parseMondayConfig,
  fetch: fetchMondayItems,
  write: writeMondayStatus,
}
