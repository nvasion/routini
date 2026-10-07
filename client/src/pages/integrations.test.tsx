// Coming-soon integrations: shown as not connectable, never offer a form.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { baseRoutes, mockFetch, renderAt } from '../test/harness'
import type { Integration } from '../lib/types'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const TTYY: Integration = {
  id: 'ttyy',
  name: 'ttyy.ai',
  description: 'AI SRE platform. Hand incidents and on-call toil to ttyy agents and get the fix back as a runbook.',
  setupUrl: 'https://ttyy.ai',
  setupLabel: 'Learn more',
  fields: [],
  status: 'not_connected',
  connectedAt: null,
  lastTestAt: null,
  lastTestOk: null,
  lastTestMessage: null,
  scopes: { agents: [] },
  serverOnly: true,
  comingSoon: true,
}

describe('coming soon integrations', () => {
  it('shows a Coming soon badge and an info-only modal with no form', async () => {
    mockFetch(
      baseRoutes({
        'GET /api/orgs/acme/integrations': () => ({ integrations: [TTYY] }),
        'GET /api/orgs/acme/mcp-servers': () => ({ servers: [] }),
      }),
    )
    renderAt('/o/acme/integrations')
    const main = await screen.findByRole('main')
    expect(await within(main).findByText('Coming soon')).toBeTruthy()

    fireEvent.click(within(main).getByRole('button', { name: /ttyy\.ai/ }))
    const dialog = await screen.findByRole('dialog', { name: 'ttyy.ai' })
    expect(within(dialog).getByText('ttyy.ai is coming soon.')).toBeTruthy()
    expect(dialog.querySelectorAll('input, select, textarea')).toHaveLength(0)
    expect(within(dialog).queryByRole('button', { name: /Connect|Save/ })).toBeNull()
  })
})
