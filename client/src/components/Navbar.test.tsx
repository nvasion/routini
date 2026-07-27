import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Navbar } from './Navbar'

// Mirrors the mocking pattern used by Dashboard.test.tsx / MetricsPage.test.tsx:
// mock the api module so tests can control the logged-in/out state directly
// instead of touching real sessionStorage.
vi.mock('../api', () => ({
  getToken: vi.fn(),
  clearToken: vi.fn(),
  apiFetch: vi.fn(),
}))

import { getToken } from '../api'

const mockedGetToken = vi.mocked(getToken)

function renderNavbar(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Navbar />
    </MemoryRouter>
  )
}

describe('Navbar', () => {
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('lists Dashboard, Metrics, Integrations, and Settings in order when logged in', () => {
    mockedGetToken.mockReturnValue('csrf-token')
    renderNavbar('/')

    const links = screen.getAllByRole('listitem').map(li => li.textContent)
    expect(links).toEqual(['Dashboard', 'Metrics', 'Integrations', 'Settings'])
  })

  it('links the Integrations tab to /integrations', () => {
    mockedGetToken.mockReturnValue('csrf-token')
    renderNavbar('/')

    const link = screen.getByRole('link', { name: 'Integrations' })
    expect(link.getAttribute('href')).toBe('/integrations')
  })

  it('marks the Integrations tab active when the current route is /integrations', () => {
    mockedGetToken.mockReturnValue('csrf-token')
    renderNavbar('/integrations')

    const integrationsLink = screen.getByRole('link', { name: 'Integrations' })
    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' })
    expect(integrationsLink.className).toContain('active')
    expect(dashboardLink.className).not.toContain('active')
  })

  it('hides all nav tabs, including Integrations, when logged out', () => {
    mockedGetToken.mockReturnValue(null)
    renderNavbar('/login')

    expect(screen.queryByRole('link', { name: 'Integrations' })).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('link', { name: 'Login' })).toBeTruthy()
  })
})
