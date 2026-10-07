// Phase 3 screens: Fleet (add server, runner state), incidents (timeline,
// notes, postmortem), alert settings, alert-triggered jobs, markdown safety.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { baseRoutes, FakeEventSource, mockFetch, renderAt } from '../test/harness'
import type { Host, IncidentDetail, Job } from '../lib/types'
import { Markdown } from '../components/Markdown'
import { ALERT_HOST, fromJob, toPayload } from './jobForm'

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const runnerHost = (over: Partial<Host> = {}): Host => ({
  id: 'h1',
  name: 'web-01',
  group: 'prod',
  address: '10.0.0.11',
  port: 22,
  username: null,
  auth: 'key',
  credentialKey: null,
  tags: ['web'],
  lastCheck: { ok: true, at: '2026-10-05T10:00:00Z', kernel: 'Linux 6.8.0', uptime: 'up 3 days, 2 hours', diskUsedPct: 63, memUsedPct: 41 },
  transport: 'runner',
  runner: { id: 'r1', name: 'web-01', version: '0.1.0', hostname: 'web-01.prod', online: true, connectedAt: '2026-10-05T09:00:00Z', lastSeenAt: '2026-10-05T10:00:00Z', capabilities: ['exec', 'pty'], facts: { osPretty: 'Ubuntu 24.04', load1: 0.42, cpus: 4 }, revoked: false },
  ...over,
})

describe('fleet', () => {
  it('shows runner state and facts, and terminals only where they can work', async () => {
    const offline = runnerHost({ id: 'h2', name: 'web-02', runner: { ...runnerHost().runner!, id: 'r2', online: false } })
    const ssh = runnerHost({ id: 'h3', name: 'lab-01', group: 'lab', transport: 'ssh', runner: null, username: 'deploy', credentialKey: 'ssh.lab' })
    mockFetch(baseRoutes({ 'GET /api/orgs/acme/hosts': () => ({ hosts: [runnerHost(), offline, ssh] }) }))
    renderAt('/o/acme/fleet')
    const main = await screen.findByRole('main')
    const web01 = await within(main).findByRole('article', { name: 'web-01' })
    expect(within(web01).getByText('runner 0.1.0')).toBeTruthy()
    expect(within(web01).getByText('Ubuntu 24.04')).toBeTruthy()
    expect(within(web01).getByText('load 0.42 · 4 cpu')).toBeTruthy()
    expect(within(web01).getByRole('button', { name: 'Terminal' })).toBeTruthy()
    const web02 = within(main).getByRole('article', { name: 'web-02' })
    expect(within(web02).getAllByText(/offline/).length).toBeGreaterThan(0)
    expect(within(web02).queryByRole('button', { name: 'Terminal' })).toBeNull()
    const lab = within(main).getByRole('article', { name: 'lab-01' })
    expect(within(lab).getByText('ssh')).toBeTruthy()
    expect(within(lab).getByRole('button', { name: 'Check' })).toBeTruthy()
    expect(within(main).getByText('3 servers · 1/2 runners online')).toBeTruthy()
  })

  it('badges hosts whose runner can run agents, and shows the Docker version', async () => {
    const agents = runnerHost({
      id: 'h4',
      name: 'build-01',
      runner: {
        ...runnerHost().runner!,
        id: 'r4',
        capabilities: ['exec', 'pty', 'agents'],
        facts: { osPretty: 'Debian 12', docker: { available: true, version: '27.1.1', agentsRunning: 0, maxAgents: 2 } },
      },
    })
    mockFetch(baseRoutes({ 'GET /api/orgs/acme/hosts': () => ({ hosts: [runnerHost(), agents] }) }))
    renderAt('/o/acme/fleet')
    const main = await screen.findByRole('main')
    const build = await within(main).findByRole('article', { name: 'build-01' })
    expect(within(build).getByText('agents')).toBeTruthy()
    expect(within(build).getByText('docker 27.1.1')).toBeTruthy()

    // web-01's runner has no agents capability and reported no Docker.
    const web01 = within(main).getByRole('article', { name: 'web-01' })
    expect(within(web01).queryByText('agents')).toBeNull()
    expect(within(web01).queryByText(/^docker /)).toBeNull()

    fireEvent.click(within(web01).getByRole('button', { name: 'Details' }))
    const dialog = await screen.findByRole('dialog', { name: 'web-01' })
    expect(within(dialog).getByText('not available')).toBeTruthy()
  })

  it('updates runners that can update themselves, and says what to run on the host otherwise', async () => {
    const commands = {
      reinstall: 'curl -fsSL https://raw.githubusercontent.com/nvasion/routini-runner/main/scripts/install.sh | sudo sh',
      enableAgents: 'sudo routini-runner-update --enable-agents',
    }
    const current = runnerHost({
      runner: { ...runnerHost().runner!, version: '0.3.0', capabilities: ['exec', 'pty', 'update'], facts: { agents: { configured: false } } },
    })
    const old = runnerHost({ id: 'h5', name: 'old-01', runner: { ...runnerHost().runner!, id: 'r5', version: '0.1.1', facts: {} } })
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/hosts': () => ({ hosts: [current, old] }),
        'GET /api/orgs/acme/runners/latest': () => ({ version: 'v0.3.1', commands }),
        'POST /api/orgs/acme/hosts/h1/runner/update': () => [202, { requestId: 'q1', version: 'v0.3.1' }],
        'GET /api/orgs/acme/hosts/h1/events': () => ({ events: [] }),
        'GET /api/orgs/acme/hosts/h5/events': () => ({ events: [] }),
      }),
    )
    renderAt('/o/acme/fleet')
    const main = await screen.findByRole('main')

    const web01 = await within(main).findByRole('article', { name: 'web-01' })
    fireEvent.click(await within(web01).findByRole('button', { name: 'Update to v0.3.1' }))
    await within(web01).findByText(/Updating to v0\.3\.1/)
    expect(log.calls.find((c) => c.method === 'POST' && c.url.endsWith('/hosts/h1/runner/update'))).toBeTruthy()

    // A runner from before 0.3.0: no button, but the one-time upgrade and the agents command.
    const oldCard = within(main).getByRole('article', { name: 'old-01' })
    expect(within(oldCard).queryByRole('button', { name: /^Update to/ })).toBeNull()
    expect(within(oldCard).getByText('update')).toBeTruthy()
    fireEvent.click(within(oldCard).getByRole('button', { name: 'Details' }))
    const dialog = await screen.findByRole('dialog', { name: 'old-01' })
    expect(within(dialog).getByLabelText('Upgrade command').textContent).toBe(commands.reinstall)
    expect(within(dialog).getByLabelText('Enable agents command').textContent).toBe(`${commands.reinstall} -s -- --enable-agents`)
    expect(within(dialog).getAllByText(/too old to run agents/).length).toBeGreaterThan(0)
  })

  it('adds a server: install commands, then waits for the runner to connect', async () => {
    let hosts: Host[] = []
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/hosts': () => ({ hosts }),
        'POST /api/orgs/acme/runners/enrollments': () => [
          201,
          {
            token: 'rre_abc',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            url: 'https://routini.example',
            commands: { script: 'curl -fsSL https://x/install.sh | sudo sh -s -- --url https://routini.example --token rre_abc', docker: 'docker run … rre_abc', manual: 'routini-runner enroll …' },
          },
        ],
      }),
    )
    renderAt('/o/acme/fleet')
    const main = await screen.findByRole('main')
    fireEvent.click(await within(main).findByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a server' })
    fireEvent.change(within(dialog).getByLabelText('Name (optional)'), { target: { value: 'db-01' } })
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: 'prod' } })
    fireEvent.change(within(dialog).getByLabelText(/^Tags/), { target: { value: 'db, prod' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Get install command' }))

    expect((await within(dialog).findByLabelText('Install command')).textContent).toContain('--token rre_abc')
    expect(log.calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'db-01', group: 'prod', tags: ['db', 'prod'] })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Docker' }))
    expect(within(dialog).getByLabelText('Install command').textContent).toBe('docker run … rre_abc')
    expect(within(dialog).getByText('Waiting for the runner to connect…')).toBeTruthy()

    hosts = [runnerHost({ id: 'h9', name: 'db-01' })]
    await waitFor(() => expect(within(dialog).getByText('db-01')).toBeTruthy(), { timeout: 4000 })
    expect(within(dialog).getByText(/is connected/)).toBeTruthy()
  })
})

describe('job editor: running an agent on a fleet host', () => {
  const ENV = { id: 'e1', name: 'app', image: 'routini/agent', repo: null, status: 'running' as const, statusDetail: null, cpus: 2, memoryMb: 2048, idleMinutes: 30, lastActiveAt: '', createdAt: '' }
  const AGENT_JOB: Job = {
    id: 'j1',
    name: 'Ship it',
    description: '',
    enabled: true,
    trigger: { kind: 'manual' },
    nextRunAt: null,
    createdAt: '',
    updatedAt: '',
    steps: [{ id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'Restart nginx' } }],
  }

  function editor() {
    const noAgents = runnerHost({ id: 'h2', name: 'web-02', runner: { ...runnerHost().runner!, id: 'r2' } })
    const ssh = runnerHost({ id: 'h3', name: 'lab-01', transport: 'ssh', runner: null })
    return mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/jobs/j1': () => ({ job: AGENT_JOB }),
        'GET /api/orgs/acme/hosts': () => ({ hosts: [runnerHost({ runner: { ...runnerHost().runner!, capabilities: ['exec', 'agents'] } }), noAgents, ssh] }),
        'GET /api/orgs/acme/environments': () => ({ environments: [ENV] }),
        'PUT /api/orgs/acme/jobs/j1': ({ body }) => ({ job: { ...AGENT_JOB, ...(body as object) } }),
      }),
    )
  }

  it('lists runner hosts, disables the ones that cannot take agents, and saves runOn', async () => {
    const log = editor()
    renderAt('/o/acme/jobs/j1')
    const main = await screen.findByRole('main')
    const runOn = (await within(main).findByLabelText('Run on')) as HTMLSelectElement
    expect([...runOn.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ['Routini sandbox', false],
      ["The alert's host (alert-triggered jobs only)", true],
      ['A host from a pool...', false],
      ['web-01', false],
      ['web-02 (agents not enabled)', true],
    ])

    fireEvent.change(runOn, { target: { value: 'h1' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'PUT')).toBe(true))
    const steps = (log.calls.find((c) => c.method === 'PUT')!.body as { steps: Array<{ config: unknown }> }).steps
    expect(steps[0]!.config).toEqual({ agent: 'claude', prompt: 'Restart nginx', runOn: { hostId: 'h1' } })
  })

  it('keeps the environment and the fleet host mutually exclusive', async () => {
    editor()
    renderAt('/o/acme/jobs/j1')
    const main = await screen.findByRole('main')
    const runOn = (await within(main).findByLabelText('Run on')) as HTMLSelectElement
    const runsIn = within(main).getByLabelText('Runs in') as HTMLSelectElement

    fireEvent.change(runOn, { target: { value: 'h1' } })
    expect(runsIn.value).toBe('')
    fireEvent.change(runsIn, { target: { value: 'e1' } })
    expect(runOn.value).toBe('')
    expect(runOn.disabled).toBe(true)

    // Back to a fresh container: the host can be chosen again.
    fireEvent.change(runsIn, { target: { value: '' } })
    expect(runOn.disabled).toBe(false)
  })
})

const DETAIL: IncidentDetail = {
  incident: {
    id: 'i1',
    number: 4,
    fingerprint: 'abc',
    title: 'DiskFull on web-01:9100: Disk above 90%',
    severity: 'critical',
    status: 'open',
    source: 'alertmanager',
    labels: { alertname: 'DiskFull', instance: 'web-01:9100' },
    annotations: { summary: 'Disk above 90%' },
    hostId: 'h1',
    hostName: 'web-01',
    alertCount: 3,
    openedAt: '2026-10-05T10:00:00Z',
    lastAlertAt: '2026-10-05T10:05:00Z',
    resolvedAt: null,
    resolvedBy: null,
    postmortem: { markdown: '# Postmortem: incident #4\n\n## Timeline (UTC)\n\n- **Check disk** (action): succeeded\n- [ ] _Detect it sooner_', generatedAt: '2026-10-05T10:30:00Z', editedAt: null, editedBy: null },
  },
  events: [
    { id: 1, ts: '2026-10-05T10:00:00Z', type: 'alert.firing', userId: null, userName: null, data: { name: 'DiskFull', severity: 'critical' } },
    { id: 2, ts: '2026-10-05T10:00:01Z', type: 'run.started', userId: null, userName: null, data: { number: 31, jobName: 'Disk full runbook' } },
  ],
  runs: [{ id: 'r31', number: 31, jobName: 'Disk full runbook', status: 'waiting', error: null, createdAt: '2026-10-05T10:00:01Z', startedAt: '2026-10-05T10:00:02Z', finishedAt: null }],
}

describe('incidents', () => {
  it('lists incidents and shows one with its alert, timeline and postmortem', async () => {
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/incidents': () => ({ incidents: [DETAIL.incident] }),
        'GET /api/orgs/acme/incidents/4': () => DETAIL,
        'POST /api/orgs/acme/incidents/4/notes': () => [201, { ok: true }],
        'PUT /api/orgs/acme/incidents/4/postmortem': () => ({ incident: DETAIL.incident }),
      }),
    )
    renderAt('/o/acme/incidents')
    const main = await screen.findByRole('main')
    fireEvent.click(await within(main).findByText('#4 DiskFull on web-01:9100: Disk above 90%'))

    await within(main).findByRole('heading', { name: '#4 DiskFull on web-01:9100: Disk above 90%' })
    expect(within(main).getByText('instance=web-01:9100')).toBeTruthy()
    expect(within(main).getByText('Started run #31: Disk full runbook')).toBeTruthy()
    expect(within(main).getByRole('heading', { name: 'Postmortem: incident #4' })).toBeTruthy()
    expect(within(main).getByText('Check disk').tagName).toBe('STRONG')

    fireEvent.change(within(main).getByLabelText('Add a note'), { target: { value: 'Rolled back 4812' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Add note' }))
    await waitFor(() => expect(log.calls.some((c) => c.url.endsWith('/notes'))).toBe(true))
    expect(log.calls.find((c) => c.url.endsWith('/notes'))!.body).toEqual({ text: 'Rolled back 4812' })

    fireEvent.click(within(main).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(main).getByLabelText('Postmortem (markdown)'), { target: { value: '# Ours' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Save postmortem' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(log.calls.find((c) => c.method === 'PUT')!.body).toEqual({ markdown: '# Ours' })
  })

  it('shows open incidents in the inbox and the nav', async () => {
    mockFetch(baseRoutes({ 'GET /api/orgs/acme/inbox': () => ({ approvals: [], failures: [], live: [], upcoming: [], incidents: [DETAIL.incident] }) }))
    renderAt('/o/acme/inbox')
    const main = await screen.findByRole('main')
    expect(await within(main).findByText('INCIDENT #4')).toBeTruthy()
    expect(screen.getByLabelText('1 open incidents')).toBeTruthy()
  })

  it('renders markdown as elements, never as HTML', () => {
    const { container } = render(<Markdown text={'## Hi <img src=x onerror=alert(1)>\n- **b** `c` _d_'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('h2')!.textContent).toBe('Hi <img src=x onerror=alert(1)>')
    expect(container.querySelector('strong')!.textContent).toBe('b')
    expect(container.querySelector('code')!.textContent).toBe('c')
  })
})

describe('alert settings and alert-triggered jobs', () => {
  it('creates an alert token and shows the Alertmanager config once', async () => {
    let configured = false
    mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/alerts/settings': () => ({ url: 'https://routini.example/api/alerts/acme', configured }),
        'POST /api/orgs/acme/alerts/token': () => {
          configured = true
          return [201, { token: 'ral_secret', url: 'https://routini.example/api/alerts/acme' }]
        },
      }),
    )
    renderAt('/o/acme/settings/alerts')
    const main = await screen.findByRole('main')
    expect((await within(main).findByLabelText('Alert endpoint')).textContent).toBe('POST https://routini.example/api/alerts/acme')
    fireEvent.click(within(main).getByRole('button', { name: 'Create token' }))
    expect((await within(main).findByLabelText('Alert token')).textContent).toBe('ral_secret')
    expect(within(main).getByText(/credentials: ral_secret/)).toBeTruthy()
  })

  it('round-trips an alert trigger and an alert-host step through the form', () => {
    const job: Job = {
      id: 'j1',
      name: 'Disk runbook',
      description: '',
      enabled: true,
      trigger: { kind: 'alert', match: { alertnames: ['DiskFull', 'Disk*'], severities: ['critical'], labels: { team: 'web' } } },
      nextRunAt: null,
      createdAt: '',
      updatedAt: '',
      steps: [{ id: 'diag', name: 'Diag', kind: 'action', when: 'on_success', retries: 0, config: { type: 'ssh', host: 'alert', command: 'df -h {{alert.labels.mount}}' } }],
    }
    const form = fromJob(job)
    expect(form.steps[0]!.hostId).toBe(ALERT_HOST)
    expect(form.alertLabels).toBe('team=web')
    const r = toPayload(form)
    expect(r.ok && r.payload).toMatchObject({ trigger: job.trigger, steps: [{ config: { type: 'ssh', host: 'alert', command: 'df -h {{alert.labels.mount}}' } }] })

    const manual = toPayload({ ...form, triggerKind: 'manual' })
    expect(manual.ok).toBe(false)
    expect(!manual.ok && manual.errors).toEqual(["Step 1 (Diag): only alert-triggered jobs can run on the alert's host."])
    const bad = toPayload({ ...form, alertLabels: 'oops' })
    expect(!bad.ok && bad.errors).toEqual(['Alert labels: "oops" should look like name=value.'])
  })
})
