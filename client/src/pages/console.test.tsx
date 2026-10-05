// Console pages rendered through the real routes with a mocked API.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { baseRoutes, EMPTY_INBOX, FakeEventSource, mockFetch, renderAt } from '../test/harness'
import type { Inbox, RunDetail } from '../lib/types'

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const RUN = {
  id: 'r1',
  number: 7,
  jobId: 'j1',
  jobName: '5xx triage',
  status: 'waiting' as const,
  trigger: 'webhook',
  costUsd: 0.38,
  agentSeconds: 0,
  error: null,
  createdAt: '2026-10-04T11:50:00Z',
  startedAt: '2026-10-04T11:50:01Z',
  finishedAt: null,
}

const INBOX: Inbox = {
  approvals: [
    { id: 'a1', runId: 'r1', stepIdx: 1, status: 'pending', message: 'Clear 5 GB of journal logs?', minRole: 'member', requestedAt: '2026-10-04T11:55:00Z', decidedBy: null, decidedAt: null, comment: null, runNumber: 7, jobName: '5xx triage', stepName: 'Gate' },
  ],
  failures: [{ ...RUN, id: 'r0', number: 6, jobName: 'cert-renew', status: 'failed', error: 'Step "renew" failed: DNS challenge timed out', finishedAt: '2026-10-04T06:00:00Z' }],
  live: [RUN],
  upcoming: [{ jobId: 'j2', name: 'Disk guard', nextRunAt: '2026-10-04T18:00:00Z' }],
}

describe('inbox', () => {
  it('shows what needs me and approves from the card', async () => {
    let inbox = INBOX
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/inbox': () => inbox,
        'POST /api/orgs/acme/runs/7/steps/1/approve': () => {
          inbox = { ...EMPTY_INBOX }
          return { ok: true }
        },
      }),
    )
    renderAt('/o/acme/inbox')
    const main = await screen.findByRole('main')
    await within(main).findByText(/Gate: Clear 5 GB of journal logs\?/)
    expect(within(main).getByText('cert-renew')).toBeTruthy()
    expect(within(main).getByText('Step "renew" failed: DNS challenge timed out')).toBeTruthy()
    expect(within(main).getByText('Disk guard')).toBeTruthy()

    fireEvent.click(within(main).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(within(main).getByText('Nothing needs you right now.')).toBeTruthy())
    const post = log.calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/orgs/acme/runs/7/steps/1/approve')
  })

  it('shows the needs-attention count in the nav', async () => {
    mockFetch(baseRoutes({ 'GET /api/orgs/acme/inbox': () => INBOX }))
    renderAt('/o/acme/inbox')
    expect(await screen.findByLabelText('2 need attention')).toBeTruthy()
  })
})

const DETAIL: RunDetail = {
  run: {
    ...RUN,
    jobSnapshot: {
      name: '5xx triage',
      steps: [
        { id: 'probe', name: 'Probe', kind: 'action', when: 'on_success', retries: 0, config: { type: 'http', url: 'https://api.example.com/health' } },
        { id: 'gate', name: 'Gate', kind: 'approval', when: 'on_success', retries: 0, config: { message: 'Clear 5 GB of journal logs?' } },
      ],
    },
    trigger: { kind: 'webhook' },
    cancelRequested: false,
  },
  steps: [
    { idx: 0, stepId: 'probe', name: 'Probe', kind: 'action', status: 'succeeded', attempt: 1, output: { statusCode: 503 }, error: null, startedAt: '2026-10-04T11:50:01Z', finishedAt: '2026-10-04T11:50:02Z' },
    { idx: 1, stepId: 'gate', name: 'Gate', kind: 'approval', status: 'waiting', attempt: 1, output: null, error: null, startedAt: '2026-10-04T11:50:02Z', finishedAt: null },
  ],
  approvals: [{ id: 'a1', runId: 'r1', stepIdx: 1, status: 'pending', message: 'Clear 5 GB of journal logs?', minRole: 'member', requestedAt: '2026-10-04T11:55:00Z', decidedBy: null, decidedAt: null, comment: null }],
}

describe('run page', () => {
  it('renders the timeline from the live stream and sends an approval with a comment', async () => {
    const log = mockFetch(baseRoutes({ 'GET /api/orgs/acme/runs/7': () => DETAIL, 'POST /api/orgs/acme/runs/7/steps/1/approve': () => ({ ok: true }) }))
    renderAt('/o/acme/runs/7')
    const main = await screen.findByRole('main')
    await within(main).findByRole('heading', { name: '5xx triage' })
    expect(within(main).getByText('Waiting on you')).toBeTruthy()

    await waitFor(() => expect(FakeEventSource.instances.some((e) => e.url === '/api/orgs/acme/runs/7/stream')).toBe(true))
    FakeEventSource.emit('/runs/7/stream', 'log', { id: 11, runId: 'r1', stepIdx: 0, ts: '2026-10-04T11:50:01Z', type: 'log', data: { message: 'Response status: 503' } })
    FakeEventSource.emit('/runs/7/stream', 'log', { id: 12, runId: 'r1', stepIdx: 0, ts: '2026-10-04T11:50:01Z', type: 'log', data: { message: 'stderr line', stream: 'stderr' } })
    expect(await within(main).findByText('Response status: 503')).toBeTruthy()
    expect(within(main).getByText('stderr line').className).toContain('stderr')

    fireEvent.change(within(main).getByLabelText('Comment'), { target: { value: 'go ahead' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'POST')).toBe(true))
    const post = log.calls.find((c) => c.method === 'POST')!
    expect(post).toMatchObject({ url: '/api/orgs/acme/runs/7/steps/1/approve', body: { comment: 'go ahead' } })
  })

  it('hides approve for a viewer and cancels for a member', async () => {
    mockFetch(
      baseRoutes({
        'GET /api/orgs/acme': () => ({ org: { id: 'o1', slug: 'acme', name: 'Acme', plan: 'free', role: 'viewer', createdAt: '', limits: { maxConcurrentRuns: 2, maxRunningEnvironments: 1, agentMinutesPerDay: null, dailyBudgetUsd: null } } }),
        'GET /api/orgs/acme/runs/7': () => DETAIL,
      }),
    )
    renderAt('/o/acme/runs/7')
    const main = await screen.findByRole('main')
    await within(main).findAllByText('Clear 5 GB of journal logs?')
    expect(within(main).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(within(main).queryByRole('button', { name: 'Cancel run' })).toBeNull()
    expect(within(main).getByText(/Waiting for someone with the member role/)).toBeTruthy()
  })
})

describe('dock and theme', () => {
  const HOSTS = [
    { id: 'h1', name: 'prod-web-01', group: 'prod', address: '10.0.0.11', port: 22, username: 'deploy', auth: 'key', credentialKey: 'ssh.prod', tags: ['web'], lastCheck: { ok: true, at: '2026-10-04T11:00:00Z', diskUsedPct: 40, memUsedPct: 50 } },
    { id: 'h2', name: 'prod-web-02', group: 'prod', address: '10.0.0.12', port: 22, username: 'deploy', auth: 'key', credentialKey: 'ssh.prod', tags: ['web'], lastCheck: null },
    { id: 'h3', name: 'homelab-01', group: 'self-hosted', address: '192.168.1.40', port: 22, username: 'me', auth: 'password', credentialKey: 'pw', tags: [], lastCheck: null },
  ]

  it('lists hosts by group and runs a health check', async () => {
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/hosts': () => ({ hosts: HOSTS }),
        'POST /api/orgs/acme/hosts/h2/check': () => ({ check: { ok: true, at: new Date().toISOString(), kernel: 'Linux 6.8', diskUsedPct: 91, memUsedPct: 30 } }),
      }),
    )
    renderAt('/o/acme/inbox')
    const dock = await screen.findByRole('complementary', { name: 'Dock' })
    await within(dock).findAllByText('prod-web-01')
    expect(within(dock).getByText('prod')).toBeTruthy()
    expect(within(dock).getByText('self-hosted')).toBeTruthy()
    fireEvent.click(within(dock).getByText('prod-web-02'))
    fireEvent.click(within(dock).getByRole('button', { name: 'Check now' }))
    await within(dock).findByText('disk 91%')
    expect(log.calls.some((c) => c.method === 'POST' && c.url === '/api/orgs/acme/hosts/h2/check')).toBe(true)
  })

  it('collapses to an icon rail and remembers it', async () => {
    mockFetch(baseRoutes())
    const first = renderAt('/o/acme/inbox')
    const dock = await screen.findByRole('complementary', { name: 'Dock' })
    fireEvent.click(within(dock).getByRole('button', { name: 'Collapse dock' }))
    expect(within(screen.getByRole('complementary', { name: 'Dock' })).getByRole('button', { name: 'Open servers' })).toBeTruthy()
    first.unmount()
    renderAt('/o/acme/inbox')
    const again = await screen.findByRole('complementary', { name: 'Dock' })
    expect(within(again).getByRole('button', { name: 'Open servers' })).toBeTruthy()
  })

  it('switches theme on <html> and remembers it', async () => {
    mockFetch(baseRoutes())
    renderAt('/o/acme/inbox')
    await screen.findByRole('main')
    expect(document.documentElement.getAttribute('data-theme')).toBe('routini')
    fireEvent.click(screen.getByRole('button', { name: 'TynHub light' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('tynhub-light')
    expect(localStorage.getItem('routini.theme')).toBe('tynhub-light')
    expect(screen.getByRole('button', { name: 'TynHub light' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('auth', () => {
  it('sends signed-out visitors to the login page', async () => {
    mockFetch({ 'GET /api/auth/me': () => [401, { error: 'Authentication required' }] })
    renderAt('/o/acme/inbox')
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('sends the CSRF token on mutations', async () => {
    const log = mockFetch(baseRoutes({ 'GET /api/orgs/acme/jobs': () => ({ jobs: [{ id: 'j1', name: 'Ping', description: '', trigger: { kind: 'manual' }, steps: [], enabled: true, nextRunAt: null, createdAt: '', updatedAt: '', lastRun: null }] }), 'POST /api/orgs/acme/jobs/j1/run': () => [201, { run: { number: 1 } }], 'GET /api/orgs/acme/runs/1': () => DETAIL }))
    renderAt('/o/acme/jobs')
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'POST')).toBe(true))
    const post = log.calls.find((c) => c.method === 'POST')!
    expect(post.headers['X-CSRF-Token']).toBe('csrf-token')
  })
})
