// Backlog source editor form model ⇄ API payload (SourceInput). Pure; see
// backlogForm.test.ts. Mirrors server/src/backlog/mapping.ts's parseMapping
// and the per-kind config parsers (monday.ts, repo.ts) closely enough to
// catch the obvious mistakes before they reach the server, which validates
// everything again.

import { ITEM_STATES, type BacklogSource, type ItemState, type SourceInput, type StatusMapping } from '../lib/types'

export type SourceKind = BacklogSource['kind']

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
    mapping: emptyMapping(),
    readyList: '',
    droppedList: '',
  }
}

/** A monday config field (`BoardConfig` in server/src/backlog/monday.ts), read as a string for the form. */
function str(config: Record<string, unknown>, key: string): string {
  const v = config[key]
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
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
  if (source.kind === 'monday') {
    f.mondayBoardId = str(source.config, 'boardId')
    f.mondayGroupId = str(source.config, 'groupId')
    f.mondayStatusColumnId = str(source.config, 'statusColumnId')
    f.mondayRepoColumnId = str(source.config, 'repoColumnId')
    f.mondayLabelsColumnId = str(source.config, 'labelsColumnId')
  } else {
    f.repoUrl = str(source.config, 'repoUrl')
    f.repoBranch = str(source.config, 'branch') || 'main'
    f.repoGlob = str(source.config, 'glob')
    const status = source.config['status'] as { kind?: string; key?: string; prefix?: string } | undefined
    f.repoStatusKind = status?.kind === 'line' ? 'line' : 'frontmatter'
    f.repoStatusKey = status?.key ?? ''
    f.repoStatusPrefix = status?.prefix ?? ''
    f.repoKey = str(source.config, 'repoKey')
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

const STATE_LABELS: Record<ItemState, string> = { ready: 'Ready', planning: 'Planning', building: 'Building', finishing: 'Finishing', done: 'Done', blocked: 'Blocked', dropped: 'Dropped' }

/** States whose out value loops back to ready if it also matches in.ready (mapping.ts: parseMapping). */
const LOOP_CHECK_STATES: ItemState[] = ['planning', 'building', 'finishing', 'done', 'blocked']

/**
 * The status mapping from the editor's rows and lists, or validation errors.
 * Mirrors server/src/backlog/mapping.ts's parseMapping: out values 1-100
 * characters, in.ready 1-20 values, in.dropped 0-20, and the loop check that
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
  for (const v of ready) if (v.length < 1 || v.length > 20) errors.push('Counts as ready: each value must be 1 to 20 characters.')

  const dropped = list(form.droppedList)
  if (dropped.length > 20) errors.push('Counts as dropped: at most 20 values.')
  for (const v of dropped) if (v.length < 1 || v.length > 20) errors.push('Counts as dropped: each value must be 1 to 20 characters.')

  for (const state of LOOP_CHECK_STATES) {
    const value = out[state]?.value
    if (value && matchesAny(value, ready)) errors.push(`'${value}' is written for ${state} and read as ready; items would loop`)
  }

  return { out, in: { ready, dropped } }
}

const DIGITS_RE = /^[0-9]+$/

function buildConfig(form: SourceForm, errors: string[]): Record<string, unknown> {
  if (form.kind === 'monday') {
    if (!DIGITS_RE.test(form.mondayBoardId.trim())) errors.push('Monday: enter the board id (digits only).')
    if (!form.mondayStatusColumnId.trim()) errors.push('Monday: enter the status column id.')
    const config: Record<string, unknown> = { boardId: form.mondayBoardId.trim(), statusColumnId: form.mondayStatusColumnId.trim() }
    if (form.mondayGroupId.trim()) config['groupId'] = form.mondayGroupId.trim()
    if (form.mondayRepoColumnId.trim()) config['repoColumnId'] = form.mondayRepoColumnId.trim()
    if (form.mondayLabelsColumnId.trim()) config['labelsColumnId'] = form.mondayLabelsColumnId.trim()
    return config
  }
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
