// ─────────────────────────────────────────────────────────────────────────────
// Linear source adapter. Reads a team's issues as backlog items and writes
// Routini's item state back onto a workflow state (and optionally a
// comment). Contract: docs/work-intake-backlog.md section 6b.
//
// All network calls go through `ctx.fetch` against the fixed Linear GraphQL
// endpoint; credentials come from `ctx.credentials('linear')` (field
// `apiKey`), sent raw (not Bearer-prefixed) in `authorization`, never from
// caller-supplied input.
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import type { AdapterCtx, SourceAdapter, SourceItem, StatusWrite } from './types.js'

const LINEAR_API_URL = 'https://api.linear.app/graphql'
const MAX_ITEMS = 500
const PAGE_SIZE = 100

export interface LinearConfig {
  teamKey: string
  /** When set, only issues carrying every one of these labels are kept. */
  labels?: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/

/** Validates a Linear source's config; throws SpecError naming the exact field. */
export function parseLinearConfig(raw: unknown): LinearConfig {
  if (!isObj(raw)) throw new SpecError('config must be an object')

  const teamKey = raw['teamKey']
  if (typeof teamKey !== 'string' || !TEAM_KEY_RE.test(teamKey)) {
    throw new SpecError('config.teamKey must match ^[A-Z][A-Z0-9]{0,9}$')
  }

  const cfg: LinearConfig = { teamKey }

  const labelsRaw = raw['labels']
  if (labelsRaw !== undefined) {
    const valid =
      Array.isArray(labelsRaw) &&
      labelsRaw.length <= 20 &&
      labelsRaw.every((l) => typeof l === 'string' && l.trim() !== '' && l.length <= 60)
    if (!valid) throw new SpecError('config.labels must be a list of 0-20 non-empty strings of at most 60 characters')
    cfg.labels = labelsRaw as string[]
  }

  return cfg
}

/** POSTs a GraphQL request to Linear and returns `data`, surfacing the first GraphQL error (if any) or a transport error. */
async function linearRequest(
  ctx: AdapterCtx,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    redirect: 'manual',
    signal: ctx.signal,
  })
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new Error(`Linear API returned an invalid response (HTTP ${res.status})`, { cause: err })
  }
  if (!isObj(json)) throw new Error(`Linear API returned an invalid response (HTTP ${res.status})`)
  const errors = json['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0]
    const message = isObj(first) && typeof first['message'] === 'string' ? first['message'] : 'Linear API returned an error'
    throw new Error(message)
  }
  if (!res.ok) throw new Error(`Linear API returned status ${res.status}`)
  const data = json['data']
  return isObj(data) ? data : {}
}

const ISSUES_QUERY = `
  query ($filter: IssueFilter!, $after: String) {
    issues(filter: $filter, first: ${PAGE_SIZE}, after: $after) {
      nodes {
        id
        title
        description
        url
        state { name }
        labels { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

function issueLabelNames(raw: Record<string, unknown>): string[] {
  const labels = raw['labels']
  const nodes = isObj(labels) ? labels['nodes'] : undefined
  if (!Array.isArray(nodes)) return []
  return nodes
    .filter(isObj)
    .map((n) => (typeof n['name'] === 'string' ? n['name'] : ''))
    .filter((s) => s.length > 0)
}

/** True when every one of `required` is present in `have`, case-insensitively. */
function hasAllLabels(have: string[], required: string[]): boolean {
  const lower = new Set(have.map((l) => l.toLowerCase()))
  return required.every((l) => lower.has(l.toLowerCase()))
}

function issueFilter(cfg: LinearConfig): Record<string, unknown> {
  const filter: Record<string, unknown> = { team: { key: { eq: cfg.teamKey } } }
  if (cfg.labels && cfg.labels.length > 0) {
    filter['labels'] = { name: { in: cfg.labels } }
  }
  return filter
}

async function fetchLinearItems(ctx: AdapterCtx, cfg: LinearConfig): Promise<SourceItem[]> {
  const creds = await ctx.credentials('linear')
  const apiKey = creds['apiKey'] ?? ''
  const filter = issueFilter(cfg)
  const requiredLabels = cfg.labels ?? []

  const result: SourceItem[] = []
  let after: string | undefined
  for (;;) {
    const data = await linearRequest(ctx, apiKey, ISSUES_QUERY, { filter, after: after ?? null })
    const issues = data['issues']
    const nodes = isObj(issues) && Array.isArray(issues['nodes']) ? issues['nodes'] : []

    for (const raw of nodes) {
      if (!isObj(raw) || typeof raw['id'] !== 'string' || raw['id'] === '') continue
      const labels = issueLabelNames(raw)
      if (requiredLabels.length > 0 && !hasAllLabels(labels, requiredLabels)) continue

      const state = raw['state']
      result.push({
        externalId: raw['id'],
        title: typeof raw['title'] === 'string' ? raw['title'] : '',
        body: typeof raw['description'] === 'string' ? raw['description'] : '',
        url: typeof raw['url'] === 'string' ? raw['url'] : null,
        state: isObj(state) && typeof state['name'] === 'string' ? state['name'] : '',
        labels,
        position: result.length,
      })
      if (result.length >= MAX_ITEMS) return result
    }

    const pageInfo = isObj(issues) ? issues['pageInfo'] : undefined
    const hasNextPage = isObj(pageInfo) && pageInfo['hasNextPage'] === true
    const endCursor = isObj(pageInfo) && typeof pageInfo['endCursor'] === 'string' ? pageInfo['endCursor'] : undefined
    if (!hasNextPage || !endCursor) return result
    after = endCursor
  }
}

const TEAM_STATES_QUERY = `
  query ($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes { states(first: 250) { nodes { id name } } }
    }
  }
`

/** Looks up the id of the team's workflow state named like `value` (case-insensitive), if any. */
async function findWorkflowStateId(ctx: AdapterCtx, apiKey: string, teamKey: string, value: string): Promise<string | undefined> {
  const data = await linearRequest(ctx, apiKey, TEAM_STATES_QUERY, { teamKey })
  const teams = data['teams']
  const teamNodes = isObj(teams) && Array.isArray(teams['nodes']) ? teams['nodes'] : []
  const team = teamNodes.find(isObj)
  const states = isObj(team) ? team['states'] : undefined
  const stateNodes = isObj(states) && Array.isArray(states['nodes']) ? states['nodes'] : []
  const match = stateNodes.find((s) => isObj(s) && typeof s['name'] === 'string' && (s['name'] as string).toLowerCase() === value.toLowerCase())
  return isObj(match) && typeof match['id'] === 'string' ? match['id'] : undefined
}

async function writeLinearStatus(
  ctx: AdapterCtx,
  cfg: LinearConfig,
  item: { externalId: string; title: string; url: string | null },
  w: StatusWrite,
): Promise<void> {
  const creds = await ctx.credentials('linear')
  const apiKey = creds['apiKey'] ?? ''

  const stateId = await findWorkflowStateId(ctx, apiKey, cfg.teamKey, w.value)
  if (!stateId) throw new Error(`No workflow state '${w.value}' in team ${cfg.teamKey}`)

  await linearRequest(
    ctx,
    apiKey,
    `mutation ($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: item.externalId, stateId },
  )

  if (w.comment) {
    await linearRequest(
      ctx,
      apiKey,
      `mutation ($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId: item.externalId, body: w.comment },
    )
  }
}

export const linearAdapter: SourceAdapter<LinearConfig> = {
  kind: 'linear',
  integration: 'linear',
  parseConfig: parseLinearConfig,
  fetch: fetchLinearItems,
  write: writeLinearStatus,
}
