// Phase 4 screens: API tokens (MCP), sign in with TynHub, the TynHub org link,
// and agent steps with Routini's tools.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { render } from '@testing-library/react'
import { baseRoutes, FakeEventSource, mockFetch, ORG, renderAt } from '../test/harness'
import { AuthProvider } from '../lib/auth'
import { ThemeProvider } from '../lib/theme'
import { AppRoutes } from '../App'
import type { Job } from '../lib/types'
import { fromJob, toPayload } from './jobForm'

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

describe('API tokens', () => {
  it('creates a token, shows it once with the Claude Code command, and revokes', async () => {
    let tokens: unknown[] = []
    const log = mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/tokens': () => ({ tokens }),
        'POST /api/orgs/acme/tokens': ({ body }) => {
          tokens = [{ id: 't1', name: (body as { name: string }).name, role: 'member', expiresAt: '2027-01-03T00:00:00Z', lastUsedAt: null, createdAt: new Date().toISOString() }]
          return [201, { token: 'rtk_secret', apiToken: tokens[0], mcpUrl: 'https://routini.example/mcp', mcpCommand: 'claude mcp add --transport http routini https://routini.example/mcp --header "Authorization: Bearer rtk_secret"' }]
        },
        'DELETE /api/orgs/acme/tokens/t1': () => {
          tokens = []
          return [204, null]
        },
      }),
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderAt('/o/acme/settings/tokens')
    const main = await screen.findByRole('main')
    await within(main).findByText('No tokens yet.')
    fireEvent.change(within(main).getByLabelText('Name'), { target: { value: 'laptop · Claude Code' } })
    fireEvent.change(within(main).getByLabelText('Acts as'), { target: { value: 'viewer' } })
    fireEvent.change(within(main).getByLabelText('Expires'), { target: { value: '30' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Create token' }))

    expect((await within(main).findByLabelText('New token')).textContent).toBe('rtk_secret')
    expect(within(main).getByLabelText('MCP command').textContent).toContain('claude mcp add --transport http routini')
    expect(log.calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'laptop · Claude Code', role: 'viewer', expiresInDays: 30 })
    expect(await within(main).findByText('laptop · Claude Code')).toBeTruthy()

    fireEvent.click(within(main).getByRole('button', { name: 'Revoke' }))
    await within(main).findByText('No tokens yet.')
  })

  it('only offers roles up to your own', async () => {
    mockFetch(baseRoutes({ 'GET /api/orgs/acme': () => ({ org: { ...ORG, role: 'member' } }), 'GET /api/orgs/acme/tokens': () => ({ tokens: [] }) }))
    renderAt('/o/acme/settings/tokens')
    const select = (await screen.findByLabelText('Acts as')) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['viewer', 'member'])
  })
})

describe('sign in with TynHub', () => {
  const renderLogin = (path: string) =>
    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    )

  it('offers "Continue with TynHub" when configured, and shows errors sent back by the callback', async () => {
    mockFetch({ 'GET /api/auth/me': () => [401, { error: 'Authentication required' }], 'GET /api/auth/providers': () => ({ oidc: { name: 'TynHub' } }) })
    renderLogin('/login?error=Signup%20is%20closed%20on%20this%20server')
    const link = await screen.findByRole('link', { name: 'Continue with TynHub' })
    expect(link.getAttribute('href')).toBe('/api/auth/oidc/start?next=%2F')
    expect(screen.getByRole('alert').textContent).toBe('Signup is closed on this server')
  })

  it('shows only the email form without a provider', async () => {
    mockFetch({ 'GET /api/auth/me': () => [401, { error: 'Authentication required' }], 'GET /api/auth/providers': () => ({ oidc: null }) })
    renderLogin('/login')
    await screen.findByRole('button', { name: 'Sign in' })
    await waitFor(() => expect(screen.queryByRole('link', { name: /Continue with/ })).toBeNull())
  })

  it('lets owners link the org to a TynHub org', async () => {
    const log = mockFetch(
      baseRoutes({
        'GET /api/auth/providers': () => ({ oidc: { name: 'TynHub' } }),
        'PUT /api/orgs/acme/tynhub': ({ body }) => ({ org: { ...ORG, tynhubOrg: (body as { tynhubOrg: string }).tynhubOrg } }),
      }),
    )
    renderAt('/o/acme/settings/general')
    const main = await screen.findByRole('main')
    fireEvent.change(await within(main).findByLabelText('TynHub org slug'), { target: { value: 'acme-inc' } })
    fireEvent.click(within(main).getByRole('button', { name: 'Save link' }))
    await within(main).findByText(/Linked\. Members of acme-inc on TynHub join this org/)
    expect(log.calls.find((c) => c.method === 'PUT')!.body).toEqual({ tynhubOrg: 'acme-inc' })
  })

  it('offers linking a password account from the account menu', async () => {
    mockFetch(baseRoutes({ 'GET /api/auth/identities': () => ({ provider: { name: 'TynHub', linked: false } }) }))
    renderAt('/o/acme/inbox')
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }))
    expect((await screen.findByRole('menuitem', { name: 'Link your TynHub account' })).getAttribute('href')).toBe('/api/auth/oidc/start?link=1')
  })
})

describe('agent steps with Routini tools', () => {
  it('round-trips the "Can use Routini" flag', () => {
    const job: Job = {
      id: 'j1',
      name: 'Triage',
      description: '',
      enabled: true,
      trigger: { kind: 'manual' },
      nextRunAt: null,
      createdAt: '',
      updatedAt: '',
      steps: [{ id: 'a', name: 'Agent', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'Look at web-01', routini: true } }],
    }
    const form = fromJob(job)
    expect(form.steps[0]!.routini).toBe(true)
    const r = toPayload(form)
    expect(r.ok && r.payload['steps']).toMatchObject([{ config: { routini: true } }])
    const off = toPayload({ ...form, steps: [{ ...form.steps[0]!, routini: false }] })
    expect(off.ok && (off.payload['steps'] as Array<{ config: Record<string, unknown> }>)[0]!.config['routini']).toBeUndefined()
  })
})
