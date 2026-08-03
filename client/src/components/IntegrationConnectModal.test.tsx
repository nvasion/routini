import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IntegrationConnectModal } from './IntegrationConnectModal'
import type { Integration } from '../types'

// IntegrationConnectModal reuses ConfigModal's overlay/panel chrome to collect
// per-integration credential fields and save them write-only via
// PUT /api/integrations/:id. These tests cover: field rendering (secret vs
// plain, required vs optional), the setup link, write-only save semantics for
// both a fresh connect and an edit of an already-connected integration, error
// surfacing, and the shared close affordances.

vi.mock('../api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../api'

const mockedApiFetch = vi.mocked(apiFetch)

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'github',
    name: 'GitHub',
    description: 'Connect a fine-grained personal access token.',
    fields: [{ key: 'token', label: 'Personal Access Token', secret: true, required: true }],
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    status: 'not_connected',
    connectedAt: null,
    lastTestAt: null,
    lastTestOk: null,
    scopes: { taskTypes: ['daily', 'developmental', 'routine'], agents: ['claude', 'opencode', 'omnimancer'] },
    ...overrides,
  }
}

function makeJiraIntegration(overrides: Partial<Integration> = {}): Integration {
  return makeIntegration({
    id: 'jira',
    name: 'Jira',
    description: 'Connect via an API token.',
    fields: [
      { key: 'siteUrl', label: 'Site URL', secret: false, required: true, placeholder: 'https://your-team.atlassian.net' },
      { key: 'email', label: 'Email', secret: false, required: true },
      { key: 'apiToken', label: 'API Token', secret: true, required: true },
    ],
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    ...overrides,
  })
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('IntegrationConnectModal', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  describe('rendering', () => {
    it('renders one input per field, blank, and a setup link', () => {
      const integration = makeJiraIntegration()
      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)

      expect(screen.getByLabelText('Site URL')).toHaveProperty('value', '')
      expect(screen.getByLabelText('Email')).toHaveProperty('value', '')
      expect(screen.getByLabelText('API Token')).toHaveProperty('value', '')

      const link = screen.getByRole('link', { name: /Get a Jira credential/ })
      expect(link.getAttribute('href')).toBe(integration.setupUrl)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
    })

    it('renders secret fields as password inputs and plain fields as text', () => {
      render(<IntegrationConnectModal integration={makeJiraIntegration()} onClose={vi.fn()} />)

      expect(screen.getByLabelText('Site URL').getAttribute('type')).toBe('text')
      expect(screen.getByLabelText('API Token').getAttribute('type')).toBe('password')
    })

    it('labels optional fields distinctly from required ones', () => {
      const integration = makeIntegration({
        fields: [
          { key: 'token', label: 'Bot Token', secret: true, required: true },
          { key: 'workspace', label: 'Workspace', secret: false, required: false },
        ],
      })
      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)

      expect(screen.getByText('Bot Token')).toBeTruthy()
      expect(screen.getByText('Workspace (optional)')).toBeTruthy()
    })

    it('shows a "Connect" save button for a not-yet-connected integration', () => {
      render(<IntegrationConnectModal integration={makeIntegration({ status: 'not_connected' })} onClose={vi.fn()} />)
      expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    })

    it('shows a "Save" button and a stored-credential hint for an already-connected integration', () => {
      render(<IntegrationConnectModal integration={makeIntegration({ status: 'connected' })} onClose={vi.fn()} />)
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
      expect(screen.getByText(/Stored credentials aren't shown here/)).toBeTruthy()
    })
  })

  describe('validation', () => {
    it('rejects saving a fresh connection with a required field left blank', async () => {
      const integration = makeJiraIntegration()
      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText('Site URL'), { target: { value: 'https://acme.atlassian.net' } })
      // Email and API Token left blank.
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/Email/)
      expect(alert.textContent).toMatch(/API Token/)
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })

    // Regression test: the real GET /api/integrations catalog never sends a
    // `required` flag at all (see server/src/routes/integrations.ts, e.g.
    // `{ key: 'token', label: 'Personal Access Token', secret: true }`) — it
    // relies on the client defaulting an absent flag to "required". A field
    // with `field.required` merely undefined must still block a blank
    // first-time connect instead of silently passing validation.
    it('rejects a blank first-time connect when fields omit the required flag entirely', async () => {
      const integration = makeIntegration({
        fields: [{ key: 'token', label: 'Personal Access Token', secret: true }],
      })
      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/Personal Access Token/)
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })

    it('does not label a field omitting the required flag as optional', () => {
      const integration = makeIntegration({
        fields: [{ key: 'token', label: 'Personal Access Token', secret: true }],
      })
      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)

      expect(screen.getByText('Personal Access Token')).toBeTruthy()
      expect(screen.queryByText('Personal Access Token (optional)')).toBeNull()
    })

    it('rejects an all-blank save on an already-connected integration as a no-op', async () => {
      render(<IntegrationConnectModal integration={makeIntegration({ status: 'connected' })} onClose={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/at least one field/i)
      expect(mockedApiFetch).not.toHaveBeenCalled()
    })
  })

  describe('write-only save', () => {
    it('saves all required fields via PUT /api/integrations/:id and shows Saved', async () => {
      const integration = makeIntegration()
      mockedApiFetch.mockResolvedValue(jsonResponse({ ...integration, status: 'connected' }))

      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'github_pat_xxx' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toBe('Saved')
      })

      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/integrations/github',
        expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json' } }),
      )
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload).toEqual({ token: 'github_pat_xxx' })
    })

    it('sends only the field the user filled in when editing an already-connected integration', async () => {
      const integration = makeJiraIntegration({ status: 'connected' })
      mockedApiFetch.mockResolvedValue(jsonResponse(integration))

      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('API Token'), { target: { value: 'new-token-value' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockedApiFetch).toHaveBeenCalled())
      const [, options] = mockedApiFetch.mock.calls[0]
      const payload = JSON.parse((options as RequestInit).body as string)
      expect(payload).toEqual({ apiToken: 'new-token-value' })
    })

    it('calls onSaved with the server-returned integration on success', async () => {
      const integration = makeIntegration()
      const onSaved = vi.fn()
      const updated = { ...integration, status: 'connected' as const, connectedAt: '2026-07-27T00:00:00.000Z' }
      mockedApiFetch.mockResolvedValue(jsonResponse(updated))

      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} onSaved={onSaved} />)
      fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'github_pat_xxx' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated))
    })

    it('surfaces a server-provided error message when the save fails', async () => {
      const integration = makeIntegration()
      mockedApiFetch.mockResolvedValue(jsonResponse({ error: 'Token rejected by GitHub' }, false, 422))

      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'bad-token' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('Token rejected by GitHub')
      })
    })

    it('falls back to a generic error message when the failed response has no error body', async () => {
      const integration = makeIntegration()
      mockedApiFetch.mockResolvedValue(jsonResponse({}, false, 500))

      render(<IntegrationConnectModal integration={integration} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Personal Access Token'), { target: { value: 'x' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/HTTP 500/)
      })
    })
  })

  describe('closing', () => {
    it('calls onClose when the close (✕) button is clicked', () => {
      const onClose = vi.fn()
      render(<IntegrationConnectModal integration={makeIntegration()} onClose={onClose} />)

      fireEvent.click(screen.getByRole('button', { name: 'Close connect modal' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when the backdrop is clicked but not when the panel itself is clicked', () => {
      const onClose = vi.fn()
      render(<IntegrationConnectModal integration={makeIntegration()} onClose={onClose} />)

      fireEvent.click(screen.getByRole('dialog'))
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('presentation'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when the Escape key is pressed', () => {
      const onClose = vi.fn()
      render(<IntegrationConnectModal integration={makeIntegration()} onClose={onClose} />)

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
