import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntegrationConnectionPanel } from './IntegrationConnectionPanel'
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
    status: 'connected',
    connectedAt: '2026-01-01T00:00:00.000Z',
    lastTestAt: null,
    lastTestOk: null,
    scopes: { taskTypes: ['daily', 'developmental', 'routine'], agents: ['claude', 'opencode', 'omnimancer'] },
    ...overrides,
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('IntegrationConnectionPanel', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('renders nothing for a not-connected integration', () => {
    const { container } = render(
      <IntegrationConnectionPanel integration={makeIntegration({ status: 'not_connected' })} />,
    )
    expect(container.innerHTML).toBe('')
  })

  describe('Test connection', () => {
    it('shows "Not tested yet" before any test has run', () => {
      render(<IntegrationConnectionPanel integration={makeIntegration()} />)
      expect(screen.getByRole('button', { name: 'Test connection' })).toBeTruthy()
      expect(screen.getByText('Not tested yet')).toBeTruthy()
    })

    it('calls POST /api/integrations/:id/test and displays the persisted result + timestamp on success', async () => {
      const integration = makeIntegration()
      mockedApiFetch.mockResolvedValue(
        jsonResponse({ ok: true, message: 'Connected as octocat', lastTestAt: '2026-07-27T10:00:00.000Z' }),
      )

      render(<IntegrationConnectionPanel integration={integration} />)
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

      await waitFor(() => {
        expect(screen.getByText('Connected as octocat')).toBeTruthy()
      })

      expect(mockedApiFetch).toHaveBeenCalledWith('/api/integrations/github/test', { method: 'POST' })
      expect(screen.getByText(/Last tested:/)).toBeTruthy()
    })

    it('invokes onTested with the server-reported result', async () => {
      const onTested = vi.fn()
      mockedApiFetch.mockResolvedValue(jsonResponse({ ok: true, lastTestAt: '2026-07-27T10:00:00.000Z' }))

      render(<IntegrationConnectionPanel integration={makeIntegration()} onTested={onTested} />)
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

      await waitFor(() => {
        expect(onTested).toHaveBeenCalledWith('github', { ok: true, lastTestAt: '2026-07-27T10:00:00.000Z' })
      })
    })

    it('surfaces a server error and does not update the result on failure', async () => {
      mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'Invalid token' }, false, 401))

      render(<IntegrationConnectionPanel integration={makeIntegration()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toBe('Invalid token')
      })
      expect(screen.getByText('Not tested yet')).toBeTruthy()
    })

    it('disables the button and shows a busy state while the test is in flight', async () => {
      let resolveFetch: (value: Response) => void = () => {}
      mockedApiFetch.mockReturnValue(
        new Promise<Response>(resolve => {
          resolveFetch = resolve
        }),
      )

      render(<IntegrationConnectionPanel integration={makeIntegration()} />)
      const button = screen.getByRole('button', { name: 'Test connection' })
      fireEvent.click(button)

      expect(screen.getByRole('button', { name: 'Testing…' })).toHaveProperty('disabled', true)

      resolveFetch(jsonResponse({ ok: true, lastTestAt: '2026-07-27T10:00:00.000Z' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeTruthy())
    })
  })

  describe('Scoping panel', () => {
    it('seeds checkboxes from the integration scopes', () => {
      render(
        <IntegrationConnectionPanel
          integration={makeIntegration({ scopes: { taskTypes: ['daily'], agents: ['claude'] } })}
        />,
      )

      expect(screen.getByLabelText('Daily')).toHaveProperty('checked', true)
      expect(screen.getByLabelText('Developmental')).toHaveProperty('checked', false)
      expect(screen.getByLabelText('Claude (Anthropic)')).toHaveProperty('checked', true)
      expect(screen.getByLabelText('OpenCode')).toHaveProperty('checked', false)
    })

    it('saves toggled scopes via PUT /api/integrations/:id and shows a saved status', async () => {
      const onScopesSaved = vi.fn()
      mockedApiFetch.mockResolvedValue(jsonResponse({}))

      render(
        <IntegrationConnectionPanel
          integration={makeIntegration({ scopes: { taskTypes: ['daily'], agents: ['claude'] } })}
          onScopesSaved={onScopesSaved}
        />,
      )

      fireEvent.click(screen.getByLabelText('Routine'))
      fireEvent.click(screen.getByLabelText('OpenCode'))
      fireEvent.click(screen.getByRole('button', { name: 'Save scopes' }))

      await waitFor(() => {
        expect(screen.getByText('Scopes saved')).toBeTruthy()
      })

      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/integrations/github',
        expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json' } }),
      )
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload).toEqual({ scopes: { taskTypes: ['daily', 'routine'], agents: ['claude', 'opencode'] } })
      expect(onScopesSaved).toHaveBeenCalledWith('github', {
        taskTypes: ['daily', 'routine'],
        agents: ['claude', 'opencode'],
      })
    })

    it('allows saving an empty scope selection (fully restricted integration)', async () => {
      mockedApiFetch.mockResolvedValue(jsonResponse({}))

      render(
        <IntegrationConnectionPanel
          integration={makeIntegration({ scopes: { taskTypes: ['daily'], agents: [] } })}
        />,
      )

      fireEvent.click(screen.getByLabelText('Daily'))
      fireEvent.click(screen.getByRole('button', { name: 'Save scopes' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled())
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload).toEqual({ scopes: { taskTypes: [], agents: [] } })
    })

    it('surfaces a server error and does not show a saved status on failure', async () => {
      mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'Scope update rejected' }, false, 400))

      render(<IntegrationConnectionPanel integration={makeIntegration()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Save scopes' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toBe('Scope update rejected')
      })
      expect(screen.queryByText('Scopes saved')).toBeNull()
    })
  })

  describe('Disconnect', () => {
    it('requires a confirmation click before calling the API', () => {
      render(<IntegrationConnectionPanel integration={makeIntegration()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

      expect(screen.getByText(/Remove the stored credentials for GitHub/)).toBeTruthy()
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })

    it('cancels the confirmation without calling the API', () => {
      render(<IntegrationConnectionPanel integration={makeIntegration()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })

    it('calls DELETE /api/integrations/:id and onDisconnected after confirming', async () => {
      const onDisconnected = vi.fn()
      mockedApiFetch.mockResolvedValue(jsonResponse({}))

      render(<IntegrationConnectionPanel integration={makeIntegration()} onDisconnected={onDisconnected} />)

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }))

      await waitFor(() => {
        expect(onDisconnected).toHaveBeenCalledWith('github')
      })
      expect(mockedApiFetch).toHaveBeenCalledWith('/api/integrations/github', { method: 'DELETE' })
    })

    it('surfaces a server error and keeps the confirmation open on failure', async () => {
      mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'Cannot disconnect: in use' }, false, 409))

      render(<IntegrationConnectionPanel integration={makeIntegration()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toBe('Cannot disconnect: in use')
      })
      expect(screen.getByRole('button', { name: 'Yes, disconnect' })).toBeTruthy()
    })
  })
})
