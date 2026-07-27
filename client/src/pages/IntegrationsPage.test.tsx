import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntegrationsPage, describeIntegrationStatus } from './IntegrationsPage'
import type { Integration } from '../types'

vi.mock('../api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../api'

const mockedApiFetch = vi.mocked(apiFetch)

function makeIntegrations(): Integration[] {
  return [
    {
      id: 'github',
      name: 'GitHub',
      description: 'Fine-grained personal access token',
      setupUrl: 'https://github.com/settings/personal-access-tokens',
      fields: [{ key: 'token', label: 'Personal Access Token', secret: true, required: true }],
      status: 'not_connected',
      connectedAt: null,
      lastTestAt: null,
      lastTestOk: null,
      scopes: { taskTypes: ['daily', 'developmental', 'routine'], agents: ['claude', 'opencode', 'omnimancer'] },
    },
    {
      id: 'slack',
      name: 'Slack',
      description: 'Bot token for posting and reading messages',
      setupUrl: 'https://api.slack.com/apps',
      fields: [{ key: 'botToken', label: 'Bot Token', secret: true, required: true }],
      status: 'connected',
      connectedAt: '2026-07-01T00:00:00.000Z',
      lastTestAt: '2026-07-20T00:00:00.000Z',
      lastTestOk: true,
      scopes: { taskTypes: ['daily'], agents: ['claude'] },
    },
    {
      id: 'jira',
      name: 'Jira',
      description: 'API token + site URL + email',
      setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      fields: [
        { key: 'apiToken', label: 'API Token', secret: true, required: true },
        { key: 'siteUrl', label: 'Site URL', secret: false, required: true },
        { key: 'email', label: 'Email', secret: false, required: true },
      ],
      status: 'error',
      connectedAt: '2026-06-15T00:00:00.000Z',
      lastTestAt: '2026-07-25T00:00:00.000Z',
      lastTestOk: false,
      scopes: { taskTypes: ['daily', 'developmental', 'routine'], agents: ['claude', 'opencode', 'omnimancer'] },
    },
  ]
}

function mockIntegrationsResponse(integrations: Integration[]): void {
  mockedApiFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ integrations }),
  } as Response)
}

describe('IntegrationsPage', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('shows a loading state before the initial fetch resolves', () => {
    mockedApiFetch.mockReturnValue(new Promise<Response>(() => {})) // never resolves
    render(<IntegrationsPage />)

    expect(screen.getByText('Loading integrations…')).toBeTruthy()
  })

  it('fetches the catalog from GET /api/integrations on mount', async () => {
    mockIntegrationsResponse(makeIntegrations())
    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeTruthy()
    })
    expect(mockedApiFetch).toHaveBeenCalledWith('/api/integrations')
  })

  it('renders one card per catalog entry with the correct status badge text', async () => {
    mockIntegrationsResponse(makeIntegrations())
    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeTruthy()
    })

    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('Error')).toBeTruthy()
  })

  it('never renders secret field keys/values, only catalog metadata', async () => {
    mockIntegrationsResponse(makeIntegrations())
    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeTruthy()
    })

    // The catalog response never includes secret values in the first place;
    // this asserts the page doesn't invent a place to leak them either
    // (e.g. no raw field key/value pairs rendered onto the card).
    expect(screen.queryByText('token')).toBeNull()
    expect(screen.queryByText('botToken')).toBeNull()
  })

  it('shows a connected-since date for connected integrations only', async () => {
    mockIntegrationsResponse(makeIntegrations())
    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByText('Slack')).toBeTruthy()
    })

    const slackCard = screen.getByRole('button', { name: /Slack/ })
    expect(slackCard.textContent).toContain('Since')
    expect(slackCard.querySelector('time')).not.toBeNull()

    // GitHub (not connected) should not show a connected-since date.
    const githubCard = screen.getByRole('button', { name: /GitHub/ })
    expect(githubCard.querySelector('time')).toBeNull()
  })

  it('invokes onSelectIntegration with the clicked integration', async () => {
    mockIntegrationsResponse(makeIntegrations())
    const onSelectIntegration = vi.fn()
    render(<IntegrationsPage onSelectIntegration={onSelectIntegration} />)

    await waitFor(() => {
      expect(screen.getByText('Jira')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /Jira/ }))

    expect(onSelectIntegration).toHaveBeenCalledTimes(1)
    expect(onSelectIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jira', status: 'error' })
    )
  })

  it('supports selecting a card via the keyboard (Enter and Space)', async () => {
    mockIntegrationsResponse(makeIntegrations())
    const onSelectIntegration = vi.fn()
    render(<IntegrationsPage onSelectIntegration={onSelectIntegration} />)

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeTruthy()
    })

    const card = screen.getByRole('button', { name: /GitHub/ })
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: ' ' })
    fireEvent.keyDown(card, { key: 'a' }) // no-op key — should not trigger selection

    expect(onSelectIntegration).toHaveBeenCalledTimes(2)
    expect(onSelectIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'github' })
    )
  })

  it('does not throw when a card is clicked without an onSelectIntegration handler', async () => {
    mockIntegrationsResponse(makeIntegrations())
    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeTruthy()
    })

    expect(() => fireEvent.click(screen.getByRole('button', { name: /GitHub/ }))).not.toThrow()
  })

  it('shows an empty state instead of a grid when the catalog is empty', async () => {
    mockIntegrationsResponse([])
    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByText('No integrations available')).toBeTruthy()
    })
  })

  it('surfaces a server-provided error banner without throwing when the fetch fails', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    } as Response)

    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.getByText('boom')).toBeTruthy()
    })
  })

  it('surfaces a generic error banner when the fetch rejects outright (network error)', async () => {
    mockedApiFetch.mockRejectedValue(new TypeError('Failed to fetch'))

    render(<IntegrationsPage />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.getByText('Failed to fetch')).toBeTruthy()
    })
  })
})

describe('describeIntegrationStatus', () => {
  it('maps each known status to a distinct, human-readable label', () => {
    expect(describeIntegrationStatus('not_connected').label).toBe('Not connected')
    expect(describeIntegrationStatus('connected').label).toBe('Connected')
    expect(describeIntegrationStatus('error').label).toBe('Error')
  })

  it('falls back to the not-connected presentation for an unrecognized status', () => {
    // Guards against a server-side enum change silently rendering a blank badge.
    expect(describeIntegrationStatus('bogus' as Integration['status']).label).toBe('Not connected')
  })
})
