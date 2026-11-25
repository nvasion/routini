import { describe, expect, it } from 'vitest'
import type { BacklogSource } from '../lib/types'
import { emptySourceForm, fromSource, matchesAny, setStatusRole, statusRole, toPayload, type SourceForm } from './backlogForm'

function mondaySource(over: Partial<BacklogSource> = {}): BacklogSource {
  return {
    id: 's1',
    orgId: 'o1',
    name: 'Product board',
    kind: 'monday',
    config: { boardId: '12345', groupId: 'topics', statusColumnId: 'status', repoColumnId: 'repo', labelsColumnId: 'labels' },
    mapping: {
      out: { planning: { value: 'In Progress' }, done: { value: 'Done', comment: true }, blocked: { value: 'Blocked' } },
      in: { ready: ['Ready', 'To Do'], dropped: ["Won't Do"] },
    },
    defaultRepoUrl: 'https://github.com/acme/app',
    defaultBaseBranch: 'main',
    factoryProjectId: 'routini',
    enabled: true,
    syncEveryMin: 5,
    nextSyncAt: '2026-11-20T00:00:00Z',
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

describe('backlog source form: round trip', () => {
  it('reads a monday source into the form and back to an equivalent payload', () => {
    const source = mondaySource()
    const form = fromSource(source)
    expect(form).toMatchObject({
      id: 's1',
      name: 'Product board',
      kind: 'monday',
      mondayBoardId: '12345',
      mondayGroupId: 'topics',
      mondayStatusColumnId: 'status',
      mondayRepoColumnId: 'repo',
      mondayLabelsColumnId: 'labels',
      defaultRepoUrl: 'https://github.com/acme/app',
      factoryProjectId: 'routini',
      readyList: 'Ready, To Do',
      droppedList: "Won't Do",
    })
    expect(form.mapping.find((r) => r.state === 'planning')).toEqual({ state: 'planning', value: 'In Progress', comment: false })
    expect(form.mapping.find((r) => r.state === 'done')).toEqual({ state: 'done', value: 'Done', comment: true })
    expect(form.mapping.find((r) => r.state === 'ready')).toEqual({ state: 'ready', value: '', comment: false })

    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload).toEqual({
      name: 'Product board',
      kind: 'monday',
      config: { boardId: '12345', groupId: 'topics', statusColumnId: 'status', repoColumnId: 'repo', labelsColumnId: 'labels' },
      mapping: {
        out: { planning: { value: 'In Progress' }, done: { value: 'Done', comment: true }, blocked: { value: 'Blocked' } },
        in: { ready: ['Ready', 'To Do'], dropped: ["Won't Do"] },
      },
      defaultBaseBranch: 'main',
      enabled: true,
      syncEveryMin: 5,
      defaultRepoUrl: 'https://github.com/acme/app',
      factoryProjectId: 'routini',
    })
  })

  it('reads a repo source into the form and back', () => {
    const source = mondaySource({
      kind: 'repo',
      config: { repoUrl: 'https://github.com/acme/specs', branch: 'tracking', glob: 'specs/**/*.md', status: { kind: 'frontmatter', key: 'status' }, repoKey: 'repo' },
      defaultRepoUrl: null,
      factoryProjectId: null,
    })
    const form = fromSource(source)
    expect(form).toMatchObject({ kind: 'repo', repoUrl: 'https://github.com/acme/specs', repoBranch: 'tracking', repoGlob: 'specs/**/*.md', repoStatusKind: 'frontmatter', repoStatusKey: 'status', repoKey: 'repo' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ repoUrl: 'https://github.com/acme/specs', branch: 'tracking', glob: 'specs/**/*.md', status: { kind: 'frontmatter', key: 'status' }, repoKey: 'repo' })
    expect(r.payload.defaultRepoUrl).toBeUndefined()
    expect(r.payload.factoryProjectId).toBeUndefined()
  })

  it('reads a line-status repo source', () => {
    const source = mondaySource({ kind: 'repo', config: { repoUrl: 'https://github.com/acme/specs', branch: 'main', glob: '*.md', status: { kind: 'line', prefix: 'Status:' } } })
    const form = fromSource(source)
    expect(form).toMatchObject({ repoStatusKind: 'line', repoStatusPrefix: 'Status:' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config['status']).toEqual({ kind: 'line', prefix: 'Status:' })
  })

  it('reads a Jira source into the form and back', () => {
    const source = mondaySource({ kind: 'jira', config: { jql: 'project = SHOP AND labels = agent-ok', repoField: 'customfield_10050' }, defaultRepoUrl: null, factoryProjectId: null })
    const form = fromSource(source)
    expect(form).toMatchObject({ kind: 'jira', jiraJql: 'project = SHOP AND labels = agent-ok', jiraRepoField: 'customfield_10050' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ jql: 'project = SHOP AND labels = agent-ok', repoField: 'customfield_10050' })
  })

  it('reads a Jira source with no repo field', () => {
    const source = mondaySource({ kind: 'jira', config: { jql: 'project = SHOP' }, defaultRepoUrl: null, factoryProjectId: null })
    const form = fromSource(source)
    expect(form).toMatchObject({ jiraJql: 'project = SHOP', jiraRepoField: '' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ jql: 'project = SHOP' })
  })

  it('reads a Linear source into the form and back', () => {
    const source = mondaySource({ kind: 'linear', config: { teamKey: 'ENG', labels: ['agent-ok', 'ready'] }, defaultRepoUrl: null, factoryProjectId: null })
    const form = fromSource(source)
    expect(form).toMatchObject({ kind: 'linear', linearTeamKey: 'ENG', linearLabels: 'agent-ok, ready' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ teamKey: 'ENG', labels: ['agent-ok', 'ready'] })
  })

  it('reads a Linear source with no labels', () => {
    const source = mondaySource({ kind: 'linear', config: { teamKey: 'ENG' }, defaultRepoUrl: null, factoryProjectId: null })
    const form = fromSource(source)
    expect(form).toMatchObject({ linearTeamKey: 'ENG', linearLabels: '' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ teamKey: 'ENG' })
  })

  it('reads an Azure Boards source into the form and back', () => {
    const source = mondaySource({
      kind: 'azure-boards',
      config: { project: 'Shop', wiql: 'SELECT [System.Id] FROM WorkItems', repoField: 'Custom.Repository' },
      defaultRepoUrl: null,
      factoryProjectId: null,
    })
    const form = fromSource(source)
    expect(form).toMatchObject({ kind: 'azure-boards', azureProject: 'Shop', azureWiql: 'SELECT [System.Id] FROM WorkItems', azureRepoField: 'Custom.Repository' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ project: 'Shop', wiql: 'SELECT [System.Id] FROM WorkItems', repoField: 'Custom.Repository' })
  })

  it('reads an Azure Boards source with the default WIQL', () => {
    const source = mondaySource({ kind: 'azure-boards', config: { project: 'Shop' }, defaultRepoUrl: null, factoryProjectId: null })
    const form = fromSource(source)
    expect(form).toMatchObject({ azureProject: 'Shop', azureWiql: '', azureRepoField: '' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ project: 'Shop' })
  })

  it('reads a GitHub Issues source into the form and back', () => {
    const source = mondaySource({
      kind: 'github-issues',
      config: { repoUrl: 'https://github.com/acme/app', labels: ['bug'], statusPrefix: 'status:' },
      defaultRepoUrl: null,
      factoryProjectId: null,
    })
    const form = fromSource(source)
    expect(form).toMatchObject({ kind: 'github-issues', githubIssuesRepoUrl: 'https://github.com/acme/app', githubIssuesLabels: 'bug', githubIssuesStatusPrefix: 'status:' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ repoUrl: 'https://github.com/acme/app', labels: ['bug'], statusPrefix: 'status:' })
  })

  it('reads a GitHub Issues source with a custom status prefix and no labels', () => {
    const source = mondaySource({ kind: 'github-issues', config: { repoUrl: 'https://github.com/acme/app', statusPrefix: 'state:' }, defaultRepoUrl: null, factoryProjectId: null })
    const form = fromSource(source)
    expect(form).toMatchObject({ githubIssuesRepoUrl: 'https://github.com/acme/app', githubIssuesLabels: '', githubIssuesStatusPrefix: 'state:' })
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ repoUrl: 'https://github.com/acme/app', statusPrefix: 'state:' })
  })

  it('a new GitHub Issues source defaults the status prefix to "status:"', () => {
    const form = { ...emptySourceForm('github-issues'), name: 'Issues', githubIssuesRepoUrl: 'https://github.com/acme/app', readyList: 'open' }
    const r = toPayload(form)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ repoUrl: 'https://github.com/acme/app', statusPrefix: 'status:' })
  })
})

describe('backlog source form: validation', () => {
  it('requires a name', () => {
    const form = { ...emptySourceForm('monday'), mondayBoardId: '1', mondayStatusColumnId: 'status', readyList: 'Ready' }
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContain('Give the source a name.')
  })

  it('rejects a name longer than 80 characters', () => {
    const form = { ...emptySourceForm('monday'), name: 'x'.repeat(81), mondayBoardId: '1', mondayStatusColumnId: 'status', readyList: 'Ready' }
    const r = toPayload(form)
    expect(!r.ok && r.errors).toContain('Name must be at most 80 characters.')
  })

  it('monday: needs a numeric board id and a status column id', () => {
    const form: SourceForm = { ...emptySourceForm('monday'), name: 'Board', mondayBoardId: 'abc', mondayStatusColumnId: '', readyList: 'Ready' }
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(['Monday: enter the board id (digits only).', 'Monday: enter the status column id.'])
  })

  it('repo: needs a URL and a glob, and rejects ".." in branch or glob', () => {
    const form: SourceForm = { ...emptySourceForm('repo'), name: 'Specs', repoUrl: '', repoGlob: '', readyList: 'Ready' }
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(['Repository: enter the GitHub repository URL (https://github.com/<owner>/<repo>).', 'Repository: enter a glob to match files.'])

    const traversal: SourceForm = { ...emptySourceForm('repo'), name: 'Specs', repoUrl: 'https://github.com/acme/specs', repoBranch: '../evil', repoGlob: '../*.md', readyList: 'Ready' }
    const r2 = toPayload(traversal)
    expect(!r2.ok && r2.errors).toEqual(['Repository: branch must not contain ..', 'Repository: glob must not contain ..'])
  })

  it('repo: needs a front matter key or a line prefix depending on the status kind', () => {
    const fm: SourceForm = { ...emptySourceForm('repo'), name: 'Specs', repoUrl: 'https://github.com/acme/specs', repoGlob: '*.md', repoStatusKind: 'frontmatter', repoStatusKey: '', readyList: 'Ready' }
    expect((toPayload(fm) as { ok: false; errors: string[] }).errors).toContain('Repository: enter the front matter key that holds the status.')

    const line: SourceForm = { ...emptySourceForm('repo'), name: 'Specs', repoUrl: 'https://github.com/acme/specs', repoGlob: '*.md', repoStatusKind: 'line', repoStatusPrefix: '', readyList: 'Ready' }
    expect((toPayload(line) as { ok: false; errors: string[] }).errors).toContain('Repository: enter the line prefix that holds the status.')
  })

  it('Jira: needs a JQL query, capped at 2000 characters', () => {
    const base = { ...emptySourceForm('jira'), name: 'Issues', readyList: 'Ready' }
    expect((toPayload({ ...base, jiraJql: '' }) as { ok: false; errors: string[] }).errors).toContain('Jira: enter the JQL query.')
    expect((toPayload({ ...base, jiraJql: 'x'.repeat(2001) }) as { ok: false; errors: string[] }).errors).toContain('Jira: the JQL query must be at most 2000 characters.')
    const r = toPayload({ ...base, jiraJql: 'project = SHOP' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ jql: 'project = SHOP' })
  })

  it('Linear: needs a team key matching the uppercase pattern', () => {
    const base = { ...emptySourceForm('linear'), name: 'Issues', readyList: 'Ready' }
    expect((toPayload({ ...base, linearTeamKey: '' }) as { ok: false; errors: string[] }).errors).toContain('Linear: enter the team key.')
    expect((toPayload({ ...base, linearTeamKey: 'eng' }) as { ok: false; errors: string[] }).errors).toContain(
      'Linear: team key must start with a letter and contain only uppercase letters and digits, up to 10 characters (e.g. ENG).',
    )
    expect((toPayload({ ...base, linearTeamKey: '1ENG' }) as { ok: false; errors: string[] }).errors.length).toBeGreaterThan(0)
    expect(toPayload({ ...base, linearTeamKey: 'ENG' }).ok).toBe(true)
  })

  it('Azure Boards: needs a valid project name, and caps WIQL at 2000 characters', () => {
    const base = { ...emptySourceForm('azure-boards'), name: 'Boards', readyList: 'Ready' }
    expect((toPayload({ ...base, azureProject: '' }) as { ok: false; errors: string[] }).errors).toContain('Azure Boards: enter the project name.')
    expect((toPayload({ ...base, azureProject: 'x'.repeat(65) }) as { ok: false; errors: string[] }).errors).toContain('Azure Boards: project name must be at most 64 characters.')
    expect((toPayload({ ...base, azureProject: 'Shop/Items' }) as { ok: false; errors: string[] }).errors).toContain("Azure Boards: 'Shop/Items' is not a valid Azure DevOps project name.")
    expect((toPayload({ ...base, azureProject: 'Shop', azureWiql: 'x'.repeat(2001) }) as { ok: false; errors: string[] }).errors).toContain('Azure Boards: WIQL must be at most 2000 characters.')
    const r = toPayload({ ...base, azureProject: 'Shop' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ project: 'Shop' })
  })

  it('GitHub Issues: needs a repository URL', () => {
    const base = { ...emptySourceForm('github-issues'), name: 'Issues', readyList: 'open' }
    expect((toPayload({ ...base, githubIssuesRepoUrl: '' }) as { ok: false; errors: string[] }).errors).toContain('GitHub Issues: enter the GitHub repository URL (https://github.com/<owner>/<repo>).')
    const r = toPayload({ ...base, githubIssuesRepoUrl: 'https://github.com/acme/app' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.config).toEqual({ repoUrl: 'https://github.com/acme/app', statusPrefix: 'status:' })
  })

  it('a mapping value over 100 characters is rejected', () => {
    const form = emptySourceForm('monday')
    form.name = 'Board'
    form.mondayBoardId = '1'
    form.mondayStatusColumnId = 'status'
    form.readyList = 'Ready'
    form.mapping = form.mapping.map((r) => (r.state === 'done' ? { ...r, value: 'x'.repeat(101) } : r))
    const r = toPayload(form)
    expect(!r.ok && r.errors).toContain('Done: the value written at the source must be at most 100 characters.')
  })

  it('"Counts as ready" needs 1 to 20 values, each at most 60 characters', () => {
    const base = { ...emptySourceForm('monday'), name: 'Board', mondayBoardId: '1', mondayStatusColumnId: 'status' }
    expect((toPayload({ ...base, readyList: '' }) as { ok: false; errors: string[] }).errors).toContain('Counts as ready: enter 1 to 20 values.')
    expect((toPayload({ ...base, readyList: Array.from({ length: 21 }, (_, i) => `r${i}`).join(', ') }) as { ok: false; errors: string[] }).errors).toContain('Counts as ready: enter 1 to 20 values.')
    expect(toPayload({ ...base, readyList: 'Ready for Development' }).ok).toBe(true)
    expect((toPayload({ ...base, readyList: 'x'.repeat(61) }) as { ok: false; errors: string[] }).errors).toContain('Counts as ready: each value must be at most 60 characters.')
  })

  it('"Counts as dropped" allows zero but caps at 20, each at most 60 characters', () => {
    const base = { ...emptySourceForm('monday'), name: 'Board', mondayBoardId: '1', mondayStatusColumnId: 'status', readyList: 'Ready' }
    expect(toPayload({ ...base, droppedList: '' }).ok).toBe(true)
    expect((toPayload({ ...base, droppedList: Array.from({ length: 21 }, (_, i) => `d${i}`).join(', ') }) as { ok: false; errors: string[] }).errors).toContain('Counts as dropped: at most 20 values.')
    expect((toPayload({ ...base, droppedList: 'x'.repeat(61) }) as { ok: false; errors: string[] }).errors).toContain('Counts as dropped: each value must be at most 60 characters.')
  })

  it('rejects an out value that would read back as ready, naming the value and state', () => {
    const form = { ...emptySourceForm('monday'), name: 'Board', mondayBoardId: '1', mondayStatusColumnId: 'status', readyList: 'Planned' }
    form.mapping = form.mapping.map((r) => (r.state === 'planning' ? { ...r, value: 'Planned (soon)' } : r))
    const r = toPayload(form)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(["'Planned (soon)' is written for planning and read as ready; items would loop"])
  })

  it('does not flag a ready or dropped out value against the loop check', () => {
    const form = { ...emptySourceForm('monday'), name: 'Board', mondayBoardId: '1', mondayStatusColumnId: 'status', readyList: 'Ready' }
    form.mapping = form.mapping.map((r) => (r.state === 'ready' ? { ...r, value: 'Ready' } : r.state === 'dropped' ? { ...r, value: 'Ready' } : r))
    const r = toPayload(form)
    expect(r.ok).toBe(true)
  })

  it('sync every minutes must be a whole number from 1 to 1440', () => {
    const base = { ...emptySourceForm('monday'), name: 'Board', mondayBoardId: '1', mondayStatusColumnId: 'status', readyList: 'Ready' }
    expect((toPayload({ ...base, syncEveryMin: '0' }) as { ok: false; errors: string[] }).errors).toContain('Sync every: must be a whole number of minutes from 1 to 1440.')
    expect((toPayload({ ...base, syncEveryMin: '1441' }) as { ok: false; errors: string[] }).errors).toContain('Sync every: must be a whole number of minutes from 1 to 1440.')
    expect((toPayload({ ...base, syncEveryMin: '2.5' }) as { ok: false; errors: string[] }).errors).toContain('Sync every: must be a whole number of minutes from 1 to 1440.')
    expect(toPayload({ ...base, syncEveryMin: '60' }).ok).toBe(true)
  })
})

describe('matchesAny', () => {
  it('matches a prefix, case-insensitively', () => {
    expect(matchesAny('Planned (2026-11-11)', ['Planned'])).toBe(true)
    expect(matchesAny('planned', ['PLANNED'])).toBe(true)
    expect(matchesAny('In Progress', ['Planned', 'Blocked'])).toBe(false)
  })

  it('is false against an empty list', () => {
    expect(matchesAny('Ready', [])).toBe(false)
  })
})

describe('statusRole / setStatusRole (the Test preview)', () => {
  const lists = { readyList: 'New, Approved', droppedList: 'Removed' }

  it('classifies a status the way a sync does: prefix, case-insensitive, ready before dropped', () => {
    expect(statusRole('new', lists)).toBe('ready')
    expect(statusRole('Approved (by PM)', lists)).toBe('ready')
    expect(statusRole('Removed', lists)).toBe('dropped')
    expect(statusRole('Active', lists)).toBe('ignored')
    expect(statusRole('', lists)).toBe('ignored')
    expect(statusRole('New', { readyList: 'New', droppedList: 'New' })).toBe('ready')
  })

  it('adds a status to the chosen list and takes it out of the other', () => {
    expect(setStatusRole(lists, 'Active', 'ready')).toEqual({ readyList: 'New, Approved, Active', droppedList: 'Removed' })
    expect(setStatusRole(lists, 'New', 'dropped')).toEqual({ readyList: 'Approved', droppedList: 'Removed, New' })
    expect(setStatusRole(lists, 'Removed', 'ignored')).toEqual({ readyList: 'New, Approved', droppedList: '' })
  })

  it('removes the prefix entry that made a status match, so "Ignored" really ignores it', () => {
    const r = setStatusRole({ readyList: 'Ready', droppedList: '' }, 'Ready for Dev', 'ignored')
    expect(r).toEqual({ readyList: '', droppedList: '' })
    expect(statusRole('Ready for Dev', r)).toBe('ignored')
  })
})
