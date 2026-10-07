import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { baseRoutes, FakeEventSource, mockFetch, renderAt } from '../test/harness'
import type { Environment, Host } from '../lib/types'
import { emptyStep, emptyJob, toPayload } from './jobForm'
import { terminalUrl } from '../lib/terminalUrl'

// xterm needs a real canvas/layout; the terminal's wiring is covered by the server tests.
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ envId }: { envId: string }) => <div data-testid="terminal">terminal for {envId}</div>,
}))

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ENV = (over: Partial<Environment> = {}): Environment => ({
  id: 'e1',
  name: 'routini-dev',
  image: 'routini/agent-claude:latest',
  repo: { url: 'https://github.com/acme/app', branch: 'main', dir: 'app' },
  status: 'running',
  statusDetail: null,
  cpus: 2,
  memoryMb: 4096,
  idleMinutes: 60,
  lastActiveAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  hostId: null,
  host: null,
  ...over,
})

const HOST = (over: Partial<Host> = {}): Host => ({
  id: 'h1',
  name: 'fleet-01',
  group: 'prod',
  address: '10.0.0.11',
  port: 22,
  username: null,
  auth: 'key',
  credentialKey: null,
  tags: [],
  lastCheck: null,
  transport: 'runner',
  runner: { id: 'r1', name: 'fleet-01', version: '0.4.0', hostname: 'fleet-01', online: true, connectedAt: null, lastSeenAt: null, capabilities: ['exec', 'agents', 'environments'], facts: null, revoked: false },
  ...over,
})

describe('environments page', () => {
  it('lists environments with the right actions and creates one', async () => {
    let envs = [ENV(), ENV({ id: 'e2', name: 'scratch', repo: null, status: 'stopped', statusDetail: 'idle for 60 minutes' })]
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/environments': () => ({ environments: envs }),
        'POST /api/orgs/acme/environments': ({ body }) => {
          envs = [...envs, ENV({ id: 'e3', name: (body as { name: string }).name, status: 'starting' })]
          return [202, { environment: envs[2] }]
        },
        'POST /api/orgs/acme/environments/e2/start': () => [202, { environment: { ...envs[1], status: 'starting' } }],
      }),
    )
    renderAt('/o/acme/environments')
    const main = await screen.findByRole('main')
    await within(main).findByText('scratch')
    expect(within(main).getByText(/idle for 60 minutes/)).toBeTruthy()
    expect(within(main).getAllByRole('button', { name: 'Terminal' })).toHaveLength(1)
    fireEvent.click(within(main).getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(log.calls.some((c) => c.url === '/api/orgs/acme/environments/e2/start')).toBe(true))

    fireEvent.click(within(main).getByRole('button', { name: 'New environment' }))
    const dialog = await screen.findByRole('dialog', { name: 'New environment' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'review-env' } })
    fireEvent.change(within(dialog).getByLabelText(/Repository/), { target: { value: 'https://github.com/acme/app' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await within(main).findByText('review-env')
    const post = log.calls.find((c) => c.method === 'POST' && c.url === '/api/orgs/acme/environments')!
    expect(post.body).toEqual({ name: 'review-env', repo: { url: 'https://github.com/acme/app', branch: 'main' }, idleMinutes: 60 })
  })

  it('lists runner hosts in the create form, disabling ones that cannot host environments, and sends the chosen hostId', async () => {
    const offline = HOST({ id: 'h-off', name: 'web-02', runner: { ...HOST().runner!, id: 'r2', online: false } })
    const noCap = HOST({ id: 'h-nocap', name: 'web-03', runner: { ...HOST().runner!, id: 'r3', capabilities: ['exec', 'agents'] } })
    const ssh = HOST({ id: 'h-ssh', name: 'ssh-01', transport: 'ssh', runner: null, username: 'deploy' })
    let envs = [ENV({ host: { id: 'h1', name: 'fleet-01' }, hostId: 'h1' })]
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/environments': () => ({ environments: envs }),
        'GET /api/orgs/acme/hosts': () => ({ hosts: [HOST(), offline, noCap, ssh] }),
        'POST /api/orgs/acme/environments': ({ body }) => {
          envs = [...envs, ENV({ id: 'e2', name: (body as { name: string }).name, status: 'starting', hostId: 'h1', host: { id: 'h1', name: 'fleet-01' } })]
          return [202, { environment: envs[1] }]
        },
      }),
    )
    renderAt('/o/acme/environments')
    const main = await screen.findByRole('main')
    // The existing environment's host shows on its card.
    expect(within(main).getByText(/on fleet-01/)).toBeTruthy()

    fireEvent.click(within(main).getByRole('button', { name: 'New environment' }))
    const dialog = await screen.findByRole('dialog', { name: 'New environment' })
    const select = within(dialog).getByLabelText('Host') as HTMLSelectElement
    const options = Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent, disabled: o.disabled }))
    expect(options).toEqual([
      { value: '', label: 'Routini', disabled: false },
      { value: 'h1', label: 'fleet-01', disabled: false },
      { value: 'h-off', label: 'web-02 (offline)', disabled: true },
      { value: 'h-nocap', label: 'web-03 (needs runner v0.4.0 with agents)', disabled: true },
    ])

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'on-fleet' } })
    fireEvent.change(select, { target: { value: 'h1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await within(main).findByText('on-fleet')
    const post = log.calls.find((c) => c.method === 'POST' && c.url === '/api/orgs/acme/environments')!
    expect(post.body).toEqual({ name: 'on-fleet', hostId: 'h1', idleMinutes: 60 })
  })

  it('opens a terminal for a running environment in the dock', async () => {
    mockFetch(baseRoutes({ 'GET /api/orgs/acme/environments': () => ({ environments: [ENV(), ENV({ id: 'e2', name: 'other' })] }) }))
    renderAt('/o/acme/environments')
    const main = await screen.findByRole('main')
    await within(main).findByText('routini-dev')
    fireEvent.click(within(main).getAllByRole('button', { name: 'Terminal' })[1]!)
    const dock = screen.getByRole('complementary', { name: 'Dock' })
    expect(await within(dock).findByTestId('terminal')).toBeTruthy()
    expect(within(dock).getByTestId('terminal').textContent).toBe('terminal for e2')
    expect(within(dock).getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('dock environments tab', () => {
  it('lists environments and starts a stopped one', async () => {
    localStorage.setItem('routini.dock', JSON.stringify({ open: true, tab: 'envs' }))
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/environments': () => ({ environments: [ENV({ status: 'stopped' })] }),
        'POST /api/orgs/acme/environments/e1/start': () => [202, { environment: ENV({ status: 'starting' }) }],
      }),
    )
    renderAt('/o/acme/inbox')
    const dock = await screen.findByRole('complementary', { name: 'Dock' })
    await within(dock).findByText('routini-dev')
    fireEvent.click(within(dock).getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(log.calls.some((c) => c.method === 'POST')).toBe(true))
  })

  it('explains when no environment is running', async () => {
    localStorage.setItem('routini.dock', JSON.stringify({ open: true, tab: 'terminal' }))
    mockFetch(baseRoutes({ 'GET /api/orgs/acme/environments': () => ({ environments: [ENV({ status: 'stopped' })] }) }))
    renderAt('/o/acme/inbox')
    const dock = await screen.findByRole('complementary', { name: 'Dock' })
    expect(await within(dock).findByText(/No running environment/)).toBeTruthy()
  })
})

describe('job form and terminal url', () => {
  it('sends environmentId instead of a repo for agent steps that run in an environment', () => {
    const form = { ...emptyJob(), name: 'in env' }
    form.steps = [{ ...emptyStep('agent', 0), prompt: 'fix it', environmentId: 'e1', repoUrl: 'https://github.com/ignored/x', output: 'pr' }]
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toEqual([{ id: 'step-1', name: 'Agent', kind: 'agent', when: 'on_success', config: { agent: 'claude', prompt: 'fix it', environmentId: 'e1', output: 'pr' } }])
  })

  it('builds ws:// and wss:// terminal URLs from the page location', () => {
    expect(terminalUrl('acme', 'e1', 80, 24, { protocol: 'http:', host: 'localhost:5173' } as Location)).toBe('ws://localhost:5173/api/orgs/acme/environments/e1/terminal?cols=80&rows=24')
    expect(terminalUrl('acme', 'e1', 80, 24, { protocol: 'https:', host: 'routini.tynhub.com' } as Location)).toBe('wss://routini.tynhub.com/api/orgs/acme/environments/e1/terminal?cols=80&rows=24')
  })
})
