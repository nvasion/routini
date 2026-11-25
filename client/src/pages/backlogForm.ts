// Backlog source editor form model ⇄ API payload (SourceInput). Pure; see
// backlogForm.test.ts. Mirrors server/src/backlog/mapping.ts's parseMapping
// and the per-kind config parsers (monday.ts, repo.ts) closely enough to
// catch the obvious mistakes before they reach the server, which validates
// everything again.

import { ITEM_STATES, type BacklogSource, type ItemState, type SourceInput, type StatusMapping } from '../lib/types'

export type SourceKind = BacklogSource['kind']

/** Kind select labels, in words (docs/work-intake-backlog.md section 9). */
export const KIND_LABELS: Record<SourceKind, string> = {
  monday: 'monday.com',
  repo: 'Tracking repo',
  jira: 'Jira',
  linear: 'Linear',
  'azure-boards': 'Azure Boards',
  'github-issues': 'GitHub Issues',
}

/** The integration a kind reads credentials from (server/src/backlog/context.ts: INTEGRATION_LABEL), named in the editor's one-line note under the kind select. */
export const KIND_INTEGRATION: Record<SourceKind, string> = {
  monday: 'monday.com',
  repo: 'GitHub',
  jira: 'Jira',
  linear: 'Linear',
  'azure-boards': 'Azure DevOps',
  'github-issues': 'GitHub',
}

/** One row of the status-mapping editor: the value written at the source for this Routini state, and whether to post it as a comment too. */
export interface MappingRow {
  state: ItemState
  value: string
  comment: boolean
}

export interface SourceForm {
  id: string | null
  name: string
  kind: SourceKind
  enabled: boolean
  defaultRepoUrl: string
  defaultBaseBranch: string
  factoryProjectId: string
  /** 1-1440. */
  syncEveryMin: string
  // monday config
  mondayBoardId: string
  mondayGroupId: string
  mondayStatusColumnId: string
  mondayRepoColumnId: string
  mondayLabelsColumnId: string
  // repo config
  repoUrl: string
  repoBranch: string
  repoGlob: string
  repoStatusKind: 'frontmatter' | 'line'
  repoStatusKey: string
  repoStatusPrefix: string
  repoKey: string
  // jira config
  jiraJql: string
  jiraRepoField: string
  // linear config
  linearTeamKey: string
  /** Comma separated label names; an issue must carry every one to be imported. */
  linearLabels: string
  // azure-boards config
  azureProject: string
  azureWiql: string
  azureRepoField: string
  // github-issues config
  githubIssuesRepoUrl: string
  /** Comma separated label names filtered on fetch. */
  githubIssuesLabels: string
  githubIssuesStatusPrefix: string
  // status mapping
  mapping: MappingRow[]
  /** Comma separated external values that mean "ready". */
  readyList: string
  /** Comma separated external values that mean "dropped". */
  droppedList: string
}

function emptyMapping(): MappingRow[] {
  return ITEM_STATES.map((state) => ({ state, value: '', comment: false }))
}

export function emptySourceForm(kind: SourceKind = 'monday'): SourceForm {
  return {
    id: null,
    name: '',
    kind,
    enabled: true,
    defaultRepoUrl: '',
    defaultBaseBranch: 'main',
    factoryProjectId: '',
    syncEveryMin: '5',
    mondayBoardId: '',
    mondayGroupId: '',
    mondayStatusColumnId: '',
    mondayRepoColumnId: '',
    mondayLabelsColumnId: '',
    repoUrl: '',
    repoBranch: 'main',
    repoGlob: '**/*.md',
    repoStatusKind: 'frontmatter',
    repoStatusKey: 'status',
    repoStatusPrefix: 'Status:',
    repoKey: '',
    jiraJql: '',
    jiraRepoField: '',
    linearTeamKey: '',
    linearLabels: '',
    azureProject: '',
    azureWiql: '',
    azureRepoField: '',
    githubIssuesRepoUrl: '',
    githubIssuesLabels: '',
    githubIssuesStatusPrefix: 'status:',
    mapping: emptyMapping(),
    readyList: '',
    droppedList: '',
  }
}

/** A config field (`BoardConfig` in server/src/backlog/monday.ts, and the other adapters' config types), read as a string for the form. */
function str(config: Record<string, unknown>, key: string): string {
  const v = config[key]
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
}

/** A config field holding a string array (Jira's repoField is not one of these; Linear's and GitHub Issues' label filters are), read as a comma separated list for the form. */
function strArrayList(config: Record<string, unknown>, key: string): string {
  const v = config[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(', ') : ''
}

export function fromSource(source: BacklogSource): SourceForm {
  const f = emptySourceForm(source.kind)
  f.id = source.id
  f.name = source.name
  f.enabled = source.enabled
  f.defaultRepoUrl = source.defaultRepoUrl ?? ''
  f.defaultBaseBranch = source.defaultBaseBranch
  f.factoryProjectId = source.factoryProjectId ?? ''
  f.syncEveryMin = String(source.syncEveryMin)
  switch (source.kind) {
    case 'monday':
      f.mondayBoardId = str(source.config, 'boardId')
      f.mondayGroupId = str(source.config, 'groupId')
      f.mondayStatusColumnId = str(source.config, 'statusColumnId')
      f.mondayRepoColumnId = str(source.config, 'repoColumnId')
      f.mondayLabelsColumnId = str(source.config, 'labelsColumnId')
      break
    case 'repo': {
      f.repoUrl = str(source.config, 'repoUrl')
      f.repoBranch = str(source.config, 'branch') || 'main'
      f.repoGlob = str(source.config, 'glob')
      const status = source.config['status'] as { kind?: string; key?: string; prefix?: string } | undefined
      f.repoStatusKind = status?.kind === 'line' ? 'line' : 'frontmatter'
      f.repoStatusKey = status?.key ?? ''
      f.repoStatusPrefix = status?.prefix ?? ''
      f.repoKey = str(source.config, 'repoKey')
      break
    }
    case 'jira':
      f.jiraJql = str(source.config, 'jql')
      f.jiraRepoField = str(source.config, 'repoField')
      break
    case 'linear':
      f.linearTeamKey = str(source.config, 'teamKey')
      f.linearLabels = strArrayList(source.config, 'labels')
      break
    case 'azure-boards':
      f.azureProject = str(source.config, 'project')
      f.azureWiql = str(source.config, 'wiql')
      f.azureRepoField = str(source.config, 'repoField')
      break
    case 'github-issues':
      f.githubIssuesRepoUrl = str(source.config, 'repoUrl')
      f.githubIssuesLabels = strArrayList(source.config, 'labels')
      f.githubIssuesStatusPrefix = str(source.config, 'statusPrefix') || 'status:'
      break
  }
  f.mapping = ITEM_STATES.map((state) => {
    const out = source.mapping.out[state]
    return { state, value: out?.value ?? '', comment: out?.comment === true }
  })
  f.readyList = source.mapping.in.ready.join(', ')
  f.droppedList = source.mapping.in.dropped.join(', ')
  return f
}

const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/** Case-insensitive prefix match: "Planned (2026-11-11)" matches "Planned" (server/src/backlog/mapping.ts). */
export function matchesAny(external: string, values: string[]): boolean {
  const e = external.toLowerCase()
  return values.some((v) => e.startsWith(v.toLowerCase()))
}

/** What a sync does with an item in this status (server/src/backlog/sync.ts): ready wins over dropped; anything else is ignored. */
export type StatusRole = 'ready' | 'dropped' | 'ignored'

export function statusRole(status: string, form: Pick<SourceForm, 'readyList' | 'droppedList'>): StatusRole {
  if (matchesAny(status, list(form.readyList))) return 'ready'
  if (matchesAny(status, list(form.droppedList))) return 'dropped'
  return 'ignored'
}

/**
 * Makes `status` count as `role`: drops every entry of both lists that
 * matches it (a prefix entry like "Ready" also matches "Ready for Dev", so
 * other statuses can change too, and the editor shows that), then appends
 * the status itself to the chosen list.
 */
export function setStatusRole(form: Pick<SourceForm, 'readyList' | 'droppedList'>, status: string, role: StatusRole): { readyList: string; droppedList: string } {
  const keep = (values: string[]) => values.filter((v) => !matchesAny(status, [v]))
  const ready = keep(list(form.readyList))
  const dropped = keep(list(form.droppedList))
  if (role === 'ready') ready.push(status)
  if (role === 'dropped') dropped.push(status)
  return { readyList: ready.join(', '), droppedList: dropped.join(', ') }
}

const STATE_LABELS: Record<ItemState, string> = { ready: 'Ready', planning: 'Planning', building: 'Building', finishing: 'Finishing', done: 'Done', blocked: 'Blocked', dropped: 'Dropped' }

/** States whose out value loops back to ready if it also matches in.ready (mapping.ts: parseMapping). */
const LOOP_CHECK_STATES: ItemState[] = ['planning', 'building', 'finishing', 'done', 'blocked']

/**
 * The status mapping from the editor's rows and lists, or validation errors.
 * Mirrors server/src/backlog/mapping.ts's parseMapping: out values 1-100
 * characters, in.ready 1-20 values, in.dropped 0-20 (each at most 60
 * characters), and the loop check that
 * rejects a planning/building/finishing/done/blocked value that would also
 * read back as ready.
 */
function buildMapping(form: SourceForm, errors: string[]): StatusMapping {
  const out: StatusMapping['out'] = {}
  for (const row of form.mapping) {
    const value = row.value.trim()
    if (!value) continue
    if (value.length > 100) errors.push(`${STATE_LABELS[row.state]}: the value written at the source must be at most 100 characters.`)
    out[row.state] = row.comment ? { value, comment: true } : { value }
  }

  const ready = list(form.readyList)
  if (ready.length < 1 || ready.length > 20) errors.push('Counts as ready: enter 1 to 20 values.')
  if (ready.some((v) => v.length > 60)) errors.push('Counts as ready: each value must be at most 60 characters.')

  const dropped = list(form.droppedList)
  if (dropped.length > 20) errors.push('Counts as dropped: at most 20 values.')
  if (dropped.some((v) => v.length > 60)) errors.push('Counts as dropped: each value must be at most 60 characters.')

  for (const state of LOOP_CHECK_STATES) {
    const value = out[state]?.value
    if (value && matchesAny(value, ready)) errors.push(`'${value}' is written for ${state} and read as ready; items would loop`)
  }

  return { out, in: { ready, dropped } }
}

const DIGITS_RE = /^[0-9]+$/
/** Linear team key (server/src/backlog/linear.ts: parseConfig). */
const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/
/** Same rule as the azure-boards action's project (server/src/engine/spec.ts): ADO forbids these characters and a leading dot. */
const AZURE_PROJECT_RE = /^[^/\\?#%*:|"<>.\x00-\x1f\x7f][^/\\?#%*:|"<>\x00-\x1f\x7f]*$/

function buildMondayConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  if (!DIGITS_RE.test(form.mondayBoardId.trim())) errors.push('Monday: enter the board id (digits only).')
  if (!form.mondayStatusColumnId.trim()) errors.push('Monday: enter the status column id.')
  const config: Record<string, unknown> = { boardId: form.mondayBoardId.trim(), statusColumnId: form.mondayStatusColumnId.trim() }
  if (form.mondayGroupId.trim()) config['groupId'] = form.mondayGroupId.trim()
  if (form.mondayRepoColumnId.trim()) config['repoColumnId'] = form.mondayRepoColumnId.trim()
  if (form.mondayLabelsColumnId.trim()) config['labelsColumnId'] = form.mondayLabelsColumnId.trim()
  return config
}

function buildRepoConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  if (!form.repoUrl.trim()) errors.push('Repository: enter the GitHub repository URL (https://github.com/<owner>/<repo>).')
  if (!form.repoGlob.trim()) errors.push('Repository: enter a glob to match files.')
  const branch = form.repoBranch.trim() || 'main'
  if (branch.includes('..')) errors.push('Repository: branch must not contain ..')
  if (form.repoGlob.includes('..')) errors.push('Repository: glob must not contain ..')
  const status: Record<string, unknown> =
    form.repoStatusKind === 'line' ? { kind: 'line', prefix: form.repoStatusPrefix.trim() } : { kind: 'frontmatter', key: form.repoStatusKey.trim() }
  if (form.repoStatusKind === 'frontmatter' && !form.repoStatusKey.trim()) errors.push('Repository: enter the front matter key that holds the status.')
  if (form.repoStatusKind === 'line' && !form.repoStatusPrefix.trim()) errors.push('Repository: enter the line prefix that holds the status.')
  const config: Record<string, unknown> = { repoUrl: form.repoUrl.trim(), branch, glob: form.repoGlob.trim(), status }
  if (form.repoKey.trim()) config['repoKey'] = form.repoKey.trim()
  return config
}

/** server/src/backlog/jira.ts: parseConfig — jql 1-2000 characters, repoField an optional custom field id. */
function buildJiraConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  const jql = form.jiraJql.trim()
  if (!jql) errors.push('Jira: enter the JQL query.')
  else if (jql.length > 2000) errors.push('Jira: the JQL query must be at most 2000 characters.')
  const config: Record<string, unknown> = { jql }
  if (form.jiraRepoField.trim()) config['repoField'] = form.jiraRepoField.trim()
  return config
}

/** server/src/backlog/linear.ts: parseConfig — teamKey matches TEAM_KEY_RE, labels all required on import. */
function buildLinearConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  const teamKey = form.linearTeamKey.trim()
  if (!teamKey) errors.push('Linear: enter the team key.')
  else if (!TEAM_KEY_RE.test(teamKey)) errors.push('Linear: team key must start with a letter and contain only uppercase letters and digits, up to 10 characters (e.g. ENG).')
  const config: Record<string, unknown> = { teamKey }
  const labels = list(form.linearLabels)
  if (labels.length) config['labels'] = labels
  return config
}

/** server/src/backlog/azureBoards.ts: parseConfig — project as the azure-boards action validates it, wiql optional up to 2000 characters. */
function buildAzureBoardsConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  const project = form.azureProject.trim()
  if (!project) errors.push('Azure Boards: enter the project name.')
  else if (project.length > 64) errors.push('Azure Boards: project name must be at most 64 characters.')
  else if (!AZURE_PROJECT_RE.test(project)) errors.push(`Azure Boards: '${project}' is not a valid Azure DevOps project name.`)
  const wiql = form.azureWiql.trim()
  if (wiql.length > 2000) errors.push('Azure Boards: WIQL must be at most 2000 characters.')
  const config: Record<string, unknown> = { project }
  if (wiql) config['wiql'] = wiql
  if (form.azureRepoField.trim()) config['repoField'] = form.azureRepoField.trim()
  return config
}

/** server/src/backlog/githubIssues.ts: parseConfig — repoUrl as the repo source's message, labels filter the fetch, statusPrefix defaults to "status:". */
function buildGithubIssuesConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  if (!form.githubIssuesRepoUrl.trim()) errors.push('GitHub Issues: enter the GitHub repository URL (https://github.com/<owner>/<repo>).')
  const config: Record<string, unknown> = { repoUrl: form.githubIssuesRepoUrl.trim(), statusPrefix: form.githubIssuesStatusPrefix.trim() || 'status:' }
  const labels = list(form.githubIssuesLabels)
  if (labels.length) config['labels'] = labels
  return config
}

function buildConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  switch (form.kind) {
    case 'monday':
      return buildMondayConfig(form, errors)
    case 'repo':
      return buildRepoConfig(form, errors)
    case 'jira':
      return buildJiraConfig(form, errors)
    case 'linear':
      return buildLinearConfig(form, errors)
    case 'azure-boards':
      return buildAzureBoardsConfig(form, errors)
    case 'github-issues':
      return buildGithubIssuesConfig(form, errors)
  }
}

export type SourcePayloadResult = { ok: true; payload: SourceInput } | { ok: false; errors: string[] }

export function toPayload(form: SourceForm): SourcePayloadResult {
  const errors: string[] = []
  const name = form.name.trim()
  if (!name) errors.push('Give the source a name.')
  else if (name.length > 80) errors.push('Name must be at most 80 characters.')

  const config = buildConfig(form, errors)
  const mapping = buildMapping(form, errors)

  const syncEveryMinRaw = form.syncEveryMin.trim()
  const syncEveryMin = Number(syncEveryMinRaw)
  if (!syncEveryMinRaw || !Number.isInteger(syncEveryMin) || syncEveryMin < 1 || syncEveryMin > 1440) errors.push('Sync every: must be a whole number of minutes from 1 to 1440.')

  if (errors.length) return { ok: false, errors }

  const payload: SourceInput = { name, kind: form.kind, config, mapping, defaultBaseBranch: form.defaultBaseBranch.trim() || 'main', enabled: form.enabled, syncEveryMin }
  if (form.defaultRepoUrl.trim()) payload.defaultRepoUrl = form.defaultRepoUrl.trim()
  if (form.factoryProjectId.trim()) payload.factoryProjectId = form.factoryProjectId.trim()
  return { ok: true, payload }
}
