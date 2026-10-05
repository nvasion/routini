import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { baseRoutes, FakeEventSource, mockFetch, renderAt } from '../test/harness'
import type { Environment } from '../lib/types'
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
