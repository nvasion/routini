// Public pages: landing, getting started and sign up.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { baseRoutes, FakeEventSource, mockFetch, renderAt } from '../../test/harness'

const signedOut = (signupOpen = true) => ({
  'GET /api/auth/me': () => [401, { error: 'Authentication required' }],
  'GET /api/auth/providers': () => ({ oidc: null, signupOpen }),
})

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

describe('landing page', () => {
  it('greets visitors with what Routini does and the way in', async () => {
    mockFetch(signedOut())
    renderAt('/')
    expect(await screen.findByRole('heading', { level: 1, name: 'Your AI engineer, on call.' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Routini' })).toBeTruthy()
    const main = screen.getByRole('main')
    expect((await within(main).findAllByRole('link', { name: 'Get started, free' }))[0]!.getAttribute('href')).toBe('/signup')
    expect(within(main).getByRole('heading', { name: 'Your fleet, without the keys' })).toBeTruthy()
    expect(within(main).getByRole('list', { name: 'Highlights' }).textContent).toContain('No inbound ports')
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login')
  })

  it('tells the story with "Read more", then shows how to install', async () => {
    mockFetch(signedOut())
    renderAt('/')
    const main = await screen.findByRole('main')
    expect(await within(main).findByText(/Routini is the engineer who takes that list/)).toBeTruthy()
    const more = () => within(main).getByText(/It reaches your servers without opening them\./).closest('#story-more') as HTMLElement
    expect(more().hidden).toBe(true)
    fireEvent.click(within(main).getByRole('button', { name: 'Read more' }))
    expect(more().hidden).toBe(false)
    expect(within(main).getByRole('button', { name: 'Read less' }).getAttribute('aria-expanded')).toBe('true')

    // Install: self-host by default, with the other options a click away.
    expect(within(main).getByLabelText('Run it yourself').textContent).toContain('make local')
    fireEvent.click(within(main).getByRole('tab', { name: 'Connect a server' }))
    expect(within(main).getByLabelText('Connect a server').textContent).toContain('install.sh')
    fireEvent.click(within(main).getByRole('tab', { name: 'Use it hosted' }))
    expect(within(main).getByText('Add a model key')).toBeTruthy()
    expect(within(main).getByRole('link', { name: /The full 5-minute guide/ }).getAttribute('href')).toBe('/docs/getting-started')

    // Where it's at, and the first questions.
    expect(within(main).getByRole('heading', { name: 'Shipped' })).toBeTruthy()
    expect(within(main).getByText('Do I have to open my servers to the internet?')).toBeTruthy()
  })

  it('offers sign in instead of sign up when the server has signup closed', async () => {
    mockFetch(signedOut(false))
    renderAt('/')
    const main = await screen.findByRole('main')
    expect((await within(main).findAllByRole('link', { name: 'Sign in' })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: /Get started/ })).toBeNull()
  })

  it('sends signed-in people straight to their console', async () => {
    mockFetch(baseRoutes({ 'GET /api/auth/providers': () => ({ oidc: null, signupOpen: true }) }))
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy()
  })
})

describe('getting started', () => {
  it('walks through setup in order, with a contents list', async () => {
    mockFetch(signedOut())
    renderAt('/docs/getting-started')
    expect(await screen.findByRole('heading', { level: 1, name: 'Getting started' })).toBeTruthy()
    const toc = screen.getByRole('complementary', { name: 'On this page' })
    expect(within(toc).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Create your account',
      'Add a model key',
      'Connect a server',
      'Create your first job',
      'Set your guardrails',
      'Turn alerts into runbooks',
      'Use Routini from Claude Code',
      'Run it yourself',
    ])
    expect(screen.getByText(/claude mcp add --transport http routini/)).toBeTruthy()
    expect(screen.getByText(/make local/)).toBeTruthy()
  })
})

describe('sign up', () => {
  it('opens on "Create account" and links back to the front page', async () => {
    mockFetch(signedOut())
    renderAt('/signup')
    expect((await screen.findByRole('tab', { name: 'Create account' })).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('Your name')).toBeTruthy()
    expect(screen.getByRole('link', { name: /New to Routini\?/ }).getAttribute('href')).toBe('/')
  })

  it('says so when signup is closed', async () => {
    mockFetch(signedOut(false))
    renderAt('/signup')
    expect(await screen.findByText(/Signup is closed on this server/)).toBeTruthy()
  })
})
