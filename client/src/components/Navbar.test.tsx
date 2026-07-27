/**
 * Navbar tests — focused on the tab set and active-link highlighting,
 * including the Integrations tab added alongside Dashboard/Metrics/Settings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Navbar } from './Navbar'

vi.mock('../api', () => ({
  getToken: vi.fn(),
  clearToken: vi.fn(),
  apiFetch: vi.fn(),
}))

import { getToken } from '../api'

const mockedGetToken = vi.mocked(getToken)

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Navbar />
    </MemoryRouter>,
  )
}

describe('Navbar', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('renders no tabs when logged out', () => {
    mockedGetToken.mockReturnValue(null)
    renderAt('/login')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('renders Dashboard, Metrics, Integrations, and Settings tabs in order when logged in', () => {
    mockedGetToken.mockReturnValue('csrf-token')
    renderAt('/')

    const links = screen.getAllByRole('listitem').map(li => li.textContent)
    expect(links).toEqual(['Dashboard', 'Metrics', 'Integrations', 'Settings'])
  })

  it('highlights the Integrations tab as active on /integrations', () => {
    mockedGetToken.mockReturnValue('csrf-token')
    renderAt('/integrations')

    const link = screen.getByRole('link', { name: 'Integrations' })
    expect(link.className).toContain('active')
  })
})
