// Phase 2 screens: policy settings, MCP servers, policy preview in the job
// editor, Factory steps and policy/egress lines on the run page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { baseRoutes, FakeEventSource, mockFetch, renderAt } from '../test/harness'
import type { Job, OrgPolicy, RunDetail } from '../lib/types'

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

const POLICY: OrgPolicy = {
  rules: [{ id: 'prod-ssh', name: 'Commands on production hosts need approval', match: { kinds: ['action'], actionTypes: ['ssh'], hostTags: ['prod'] }, effect: 'require_approval', minRole: 'admin' }],
  egress: { allowedHosts: ['api.anthropic.com', 'github.com'] },
  updatedAt: null,
  isDefault: true,
}

describe('policy settings', () => {
  it('shows the broker state, edits rules and the allow-list, and saves', async () => {
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/policy': () => ({ policy: POLICY, brokerEnabled: false }),
        'PUT /api/orgs/acme/policy': ({ body }) => ({ policy: { ...POLICY, ...(body as object), isDefault: false, updatedAt: new Date().toISOString() }, brokerEnabled: false }),
      }),
    )
    renderAt('/o/acme/settings/policy')
    const main = await screen.findByRole('main')
    expect(await within(main).findByText('Credential broker off')).toBeTruthy()
    expect((within(main).getByLabelText('SSH host tags') as HTMLInputElement).value).toBe('prod')

    fireEvent.click(within(main).getByRole('button', { name: 'Rule' }))
    const names = within(main).getAllByLabelText('Rule name')
    fireEvent.change(names[1]!, { target: { value: 'No prod pushes' } })
    fireEvent.change(within(main).getAllByLabelText('Then')[1]!, { target: { value: 'deny' } })
    fireEvent.change(within(main).getByLabelText('Reason shown to the job author'), { target: { value: 'Use a PR' } })
    fireEvent.click(within(main).getByRole('checkbox', { name: 'Branch push' }))
    fireEvent.change(within(main).getByLabelText('Hosts agents may reach'), { target: { value: 'api.anthropic.com\n*.Example.com' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Save policy' }))

    await within(main).findByText(/Policy saved/)
    const put = log.calls.find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({
      rules: [
        POLICY.rules[0],
        { id: 'rule-2', name: 'No prod pushes', effect: 'deny', reason: 'Use a PR', match: { kinds: ['agent'], agentOutputs: ['branch'] } },
      ],
      egress: { allowedHosts: ['api.anthropic.com', '*.example.com'] },
    })
  })

  it('is read-only for members', async () => {
    mockFetch(
      baseRoutes({
        'GET /api/orgs/acme': () => ({ org: { id: 'o1', slug: 'acme', name: 'Acme', plan: 'free', role: 'member', createdAt: '', limits: { maxConcurrentRuns: 2, maxRunningEnvironments: 1, agentMinutesPerDay: null, dailyBudgetUsd: null } } }),
        'GET /api/orgs/acme/policy': () => ({ policy: POLICY, brokerEnabled: true }),
      }),
    )
    renderAt('/o/acme/settings/policy')
    const main = await screen.findByRole('main')
    expect(await within(main).findByText('Credential broker on')).toBeTruthy()
    expect(within(main).queryByRole('button', { name: 'Save policy' })).toBeNull()
    expect(within(main).getByText('Only admins can change the policy.')).toBeTruthy()
  })
})

describe('MCP servers', () => {
  it('adds a server with a write-only header and tests it', async () => {
    const created = { id: '00000000-0000-0000-0000-000000000001', name: 'linear', url: 'https://mcp.linear.app/mcp', headerNames: ['authorization'], agents: ['claude'], lastTest: null, createdAt: '' }
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/integrations': () => ({ integrations: [] }),
        'GET /api/orgs/acme/mcp-servers': () => ({ servers: [] }),
        'POST /api/orgs/acme/mcp-servers': () => [201, { server: created }],
        [`POST /api/orgs/acme/mcp-servers/${created.id}/test`]: () => ({ test: { ok: true, at: new Date().toISOString(), message: 'Connected to Linear 1.0' } }),
      }),
    )
    renderAt('/o/acme/integrations')
    const main = await screen.findByRole('main')
    await within(main).findByText('No MCP servers yet.')
    fireEvent.click(within(main).getByRole('button', { name: 'MCP server' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add MCP server' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'linear' } })
    fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: 'https://mcp.linear.app/mcp' } })
    fireEvent.change(within(dialog).getByLabelText('Header value'), { target: { value: 'Bearer lin_secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))

    const edit = await screen.findByRole('dialog', { name: 'MCP server linear' })
    expect(within(edit).getByText('authorization')).toBeTruthy()
    expect(log.calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'linear', url: 'https://mcp.linear.app/mcp', agents: ['claude'], headers: { authorization: 'Bearer lin_secret' } })
    fireEvent.click(within(edit).getByRole('button', { name: 'Test connection' }))
    expect(await within(edit).findByText('Test passed: Connected to Linear 1.0')).toBeTruthy()
  })

  it('does not offer agent scopes for server-only integrations', async () => {
    mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/integrations': () => ({
          integrations: [
            { id: 'factory', name: 'Factory', description: 'Start Factory orchestrations', setupUrl: 'https://factory-nexus.ai', setupLabel: 'Create a key', fields: [{ key: 'apiToken', label: 'API key', secret: true }], status: 'not_connected', connectedAt: null, lastTestAt: null, lastTestOk: null, lastTestMessage: null, scopes: { agents: [] }, serverOnly: true },
          ],
        }),
        'GET /api/orgs/acme/mcp-servers': () => ({ servers: [] }),
      }),
    )
    renderAt('/o/acme/integrations')
    fireEvent.click(await screen.findByRole('button', { name: /Factory/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Factory' })
    expect(within(dialog).queryByText('Agents that may use it')).toBeNull()
    expect(within(dialog).getByText(/never handed to agents/)).toBeTruthy()
  })
})

const JOB: Job = {
  id: 'j1',
  name: 'Ship it',
  description: '',
  enabled: true,
  trigger: { kind: 'manual' },
  nextRunAt: null,
  createdAt: '',
  updatedAt: '',
  steps: [
    { id: 'disk', name: 'Disk', kind: 'action', when: 'on_success', retries: 0, config: { type: 'ssh', hostId: 'h1', command: 'df -h' } },
    { id: 'build', name: 'Build', kind: 'action', when: 'on_success', retries: 0, config: { type: 'factory', operation: 'orchestrate', projectId: 'routini', request: 'Add dark mode', runtime: 'omnimancer', provider: 'openrouter', model: 'anthropic/claude-opus-5', createPr: true } },
  ],
}

describe('job editor', () => {
  it('previews policy decisions per step and edits a Factory step', async () => {
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/jobs/j1': () => ({ job: JOB }),
        'POST /api/orgs/acme/policy/evaluate': () => ({
          decisions: [
            { stepId: 'disk', effect: 'require_approval', rule: { id: 'prod-ssh', name: 'Prod SSH', minRole: 'admin' } },
            { stepId: 'build', effect: 'deny', rule: { id: 'no-factory', name: 'No Factory', reason: 'Not yet' } },
          ],
        }),
        'PUT /api/orgs/acme/jobs/j1': ({ body }) => ({ job: { ...JOB, ...(body as object) } }),
      }),
    )
    renderAt('/o/acme/jobs/j1')
    const main = await screen.findByRole('main')
    expect(await within(main).findByText('needs admin approval', {}, { timeout: 3000 })).toBeTruthy()
    expect(within(main).getByText('blocked by policy')).toBeTruthy()
    expect(log.calls.find((c) => c.url.endsWith('/policy/evaluate'))!.body).toMatchObject({ steps: [{ id: 'disk' }, { id: 'build', config: { type: 'factory' } }] })

    expect((within(main).getByLabelText('Model') as HTMLInputElement).value).toBe('anthropic/claude-opus-5')
    fireEvent.change(within(main).getByLabelText('What should Factory build?'), { target: { value: 'Add dark mode and tests' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'PUT')).toBe(true))
    const steps = (log.calls.find((c) => c.method === 'PUT')!.body as { steps: unknown[] }).steps
    expect(steps[1]).toEqual({ id: 'build', name: 'Build', kind: 'action', when: 'on_success', config: { ...JOB.steps[1]!.config, request: 'Add dark mode and tests' } })
  })
})

describe('run page (policy and egress)', () => {
  const DETAIL: RunDetail = {
    run: {
      id: 'r1',
      number: 9,
      jobId: 'j1',
      jobName: 'Fix flaky test',
      status: 'waiting',
      trigger: { kind: 'manual' },
      costUsd: 0,
      agentSeconds: 0,
      error: null,
      createdAt: '2026-10-04T11:50:00Z',
      startedAt: '2026-10-04T11:50:01Z',
      finishedAt: null,
      jobSnapshot: { name: 'Fix flaky test', steps: [{ id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'Fix it' } }] },
      cancelRequested: false,
    } as RunDetail['run'],
    steps: [{ idx: 0, stepId: 'fix', name: 'Fix', kind: 'agent', status: 'waiting', attempt: 1, output: null, error: null, startedAt: null, finishedAt: null }],
    approvals: [
      { id: 'a1', runId: 'r1', stepIdx: 0, status: 'pending', message: 'Agent may push to main', minRole: 'admin', requestedAt: '2026-10-04T11:50:02Z', decidedBy: null, decidedAt: null, comment: null, source: 'policy', rule: 'Agent pushes' },
    ],
  }

  it('labels policy approvals and shows blocked egress', async () => {
    mockFetch(baseRoutes({ 'GET /api/orgs/acme/runs/9': () => DETAIL }))
    renderAt('/o/acme/runs/9')
    const main = await screen.findByRole('main')
    expect(await within(main).findByText('POLICY · Agent pushes')).toBeTruthy()
    await waitFor(() => expect(FakeEventSource.instances.some((e) => e.url.endsWith('/runs/9/stream'))).toBe(true))
    FakeEventSource.emit('/runs/9/stream', 'approval.requested', { id: 1, runId: 'r1', stepIdx: 0, ts: '', type: 'approval.requested', data: { source: 'policy', rule: 'Agent pushes' } })
    FakeEventSource.emit('/runs/9/stream', 'egress.blocked', { id: 2, runId: 'r1', stepIdx: 0, ts: '', type: 'egress.blocked', data: { hosts: ['evil.example', 'pastebin.com'] } })
    expect(await within(main).findByText('approval required by policy “Agent pushes”')).toBeTruthy()
    expect(within(main).getByText('blocked outbound (not on the allow-list): evil.example, pastebin.com')).toBeTruthy()
  })
})
