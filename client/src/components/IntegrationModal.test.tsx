import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntegrationModal } from './IntegrationModal'
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

describe('IntegrationModal', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  describe('connecting (not yet connected)', () => {
    it('renders one input per catalog field, using type=password for secrets', () => {
      render(<IntegrationModal integration={makeIntegration()} onClose={vi.fn()} onChange={vi.fn()} />)
      const input = screen.getByLabelText('Personal Access Token') as HTMLInputElement
      expect(input.type).toBe('password')
    })

    it('does not show scoping, Test connection, or Disconnect before first connect', () => {
      render(<IntegrationModal integration={makeIntegration()} onClose={vi.fn()} onChange={vi.fn()} />)
      expect(screen.queryByText('Scoping')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
    })

    it('rejects a Connect attempt with a missing field, without calling the API', async () => {
      render(<IntegrationModal integration={makeIntegration()} onClose={vi.fn()} onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      expect(await screen.findByRole('alert')).toBeTruthy()
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })

    it('connects on a valid submit and reports the fresh status via onChange', async () => {
      const onChange = vi.fn()
      const updated = makeIntegration({ status: 'connected', connectedAt: '2024-01-01T00:00:00.000Z' })
      mockedApiFetch.mockResolvedValue(jsonResponse(updated))

      render(<IntegrationModal integration={makeIntegration()} onClose={vi.fn()} onChange={onChange} />)
      fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'ghp_secret_value' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      await waitFor(() => expect(onChange).toHaveBeenCalledWith(updated))

      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/integrations/github',
        expect.objectContaining({ method: 'PUT' }),
      )
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload.credentials).toEqual({ token: 'ghp_secret_value' })
    })

    it('surfaces a server-provided error message when connect fails', async () => {
      mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'Missing required field "token"' }, false, 400))

      render(<IntegrationModal integration={makeIntegration()} onClose={vi.fn()} onChange={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'ghp_x' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('Missing required field')
      })
    })
  })

  describe('managing a connected integration', () => {
    function connectedIntegration(overrides: Partial<Integration> = {}): Integration {
      return makeIntegration({
        status: 'connected',
        connectedAt: '2024-01-01T00:00:00.000Z',
        ...overrides,
      })
    }

    it('allows saving scopes without resupplying credentials', async () => {
      const onChange = vi.fn()
      mockedApiFetch.mockResolvedValue(jsonResponse(connectedIntegration()))

      render(<IntegrationModal integration={connectedIntegration()} onClose={vi.fn()} onChange={onChange} />)
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled())
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload.credentials).toBeUndefined()
      expect(payload.scopes).toEqual({
        taskTypes: ['daily', 'developmental', 'routine'],
        agents: ['claude', 'opencode', 'omnimancer'],
      })
    })

    it('toggles a task-type scope checkbox', async () => {
      const onChange = vi.fn()
      mockedApiFetch.mockResolvedValue(jsonResponse(connectedIntegration()))

      render(<IntegrationModal integration={connectedIntegration()} onClose={vi.fn()} onChange={onChange} />)
      fireEvent.click(screen.getByRole('checkbox', { name: 'daily' }))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled())
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload.scopes.taskTypes).toEqual(['developmental', 'routine'])
    })

    it('runs a connection test and shows a success result', async () => {
      const tested = connectedIntegration({ lastTestAt: '2024-01-02T00:00:00.000Z', lastTestOk: true })
      mockedApiFetch.mockResolvedValue(jsonResponse(tested))

      render(<IntegrationModal integration={connectedIntegration()} onClose={vi.fn()} onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

      await waitFor(() => {
        expect(mockedApiFetch).toHaveBeenCalledWith('/api/integrations/github/test', { method: 'POST' })
      })
    })

    it('surfaces a test failure message inline', async () => {
      mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'Connection test failed' }, false, 500))

      render(<IntegrationModal integration={connectedIntegration()} onClose={vi.fn()} onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('Connection test failed')
      })
    })

    it('disconnects and closes the modal', async () => {
      const onChange = vi.fn()
      const onClose = vi.fn()
      mockedApiFetch.mockResolvedValue(jsonResponse(makeIntegration({ status: 'not_connected' })))

      render(<IntegrationModal integration={connectedIntegration()} onClose={onClose} onChange={onChange} />)
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

      await waitFor(() => {
        expect(mockedApiFetch).toHaveBeenCalledWith('/api/integrations/github', { method: 'DELETE' })
        expect(onChange).toHaveBeenCalled()
        expect(onClose).toHaveBeenCalled()
      })
    })
  })

  describe('closing', () => {
    it('calls onClose when the close (✕) button is clicked', () => {
      const onClose = vi.fn()
      render(<IntegrationModal integration={makeIntegration()} onClose={onClose} onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Close integration modal' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when the backdrop is clicked but not the panel itself', () => {
      const onClose = vi.fn()
      render(<IntegrationModal integration={makeIntegration()} onClose={onClose} onChange={vi.fn()} />)

      fireEvent.click(screen.getByRole('dialog'))
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('presentation'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when Escape is pressed', () => {
      const onClose = vi.fn()
      render(<IntegrationModal integration={makeIntegration()} onClose={onClose} onChange={vi.fn()} />)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
