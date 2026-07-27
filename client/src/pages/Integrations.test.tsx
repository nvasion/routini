import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Integrations } from './Integrations'
import type { Integration } from '../types'

vi.mock('../api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../api'

const mockedApiFetch = vi.mocked(apiFetch)

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'github',
    name: 'GitHub',
    description: 'Fine-grained personal access token for repository access.',
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    fields: [{ key: 'token', label: 'Personal Access Token', secret: true }],
    status: 'not_connected',
    connectedAt: null,
    lastTestAt: null,
    lastTestOk: null,
    scopes: { taskTypes: ['daily', 'developmental', 'routine'], agents: ['claude', 'opencode', 'omnimancer'] },
    ...overrides,
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('Integrations page', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('shows a loading state before the initial fetch resolves', () => {
    mockedApiFetch.mockReturnValue(new Promise<Response>(() => {}))
    render(<Integrations />)
    expect(screen.getByText('Loading integrations…')).toBeTruthy()
  })

  it('renders a card with a status badge for each catalog integration', async () => {
    mockedApiFetch.mockResolvedValue(
      jsonResponse({
        integrations: [
          makeIntegration({ id: 'github', name: 'GitHub', status: 'not_connected' }),
          makeIntegration({ id: 'slack', name: 'Slack', status: 'connected', connectedAt: '2024-01-01T00:00:00.000Z' }),
        ],
      }),
    )

    render(<Integrations />)

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeTruthy()
    })

    const items = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByText('Not connected')).toBeTruthy()
    expect(within(items[1]).getByText('Connected')).toBeTruthy()
  })

  it('surfaces an error banner without throwing when the initial fetch fails', async () => {
    mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500))
    render(<Integrations />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
  })

  it('opens the connect modal for the clicked integration', async () => {
    mockedApiFetch.mockResolvedValue(jsonResponse({ integrations: [makeIntegration()] }))
    render(<Integrations />)

    await waitFor(() => screen.getByRole('button', { name: 'Configure GitHub' }))
    fireEvent.click(screen.getByRole('button', { name: 'Configure GitHub' }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('Personal Access Token')).toBeTruthy()
  })

  it('opens the connect modal via keyboard (Enter)', async () => {
    mockedApiFetch.mockResolvedValue(jsonResponse({ integrations: [makeIntegration()] }))
    render(<Integrations />)

    await waitFor(() => screen.getByRole('button', { name: 'Configure GitHub' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Configure GitHub' }), { key: 'Enter' })

    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})
