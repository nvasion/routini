import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { IntegrationsPage } from './IntegrationsPage'

describe('IntegrationsPage', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the page heading and subtitle', () => {
    render(<IntegrationsPage />)

    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeTruthy()
    expect(
      screen.getByText('Connect the external tools your tasks and coding agents work with')
    ).toBeTruthy()
  })

  it('shows a placeholder state since the catalog grid is not built yet', () => {
    render(<IntegrationsPage />)

    expect(screen.getByText('No integrations catalog yet')).toBeTruthy()
  })
})
