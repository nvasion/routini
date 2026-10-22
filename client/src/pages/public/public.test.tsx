// Public pages: landing, how it works (with the old getting-started URL) and sign up.

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
    expect(within(main).getByRole('link', { name: /The full 5-minute walkthrough/ }).getAttribute('href')).toBe('/how-it-works')

    // What it does now covers agents on your own servers, and shows the integrations.
    expect(within(main).getByRole('heading', { name: 'Agents on your own servers' })).toBeTruthy()
    const marks = within(main).getByRole('list', { name: 'Integrations' })
    expect(within(marks).getByText('Azure DevOps')).toBeTruthy()
    expect(marks.querySelector('[data-integration="teams"]')).toBeTruthy()

    // Where it's at, and the first questions.
    expect(within(main).getByRole('heading', { name: 'Shipped' })).toBeTruthy()
    expect(within(main).getByText(/Hosted alpha at routini\.tynhub\.com/)).toBeTruthy()
    expect(within(main).getByText('Do I have to open my servers to the internet?')).toBeTruthy()
    expect(within(main).getByText('Can agents run on my own servers?')).toBeTruthy()
  })

  it('shows how it works in screenshots of the console, one per theme', async () => {
    mockFetch(signedOut())
    renderAt('/')
    const main = await screen.findByRole('main')
    // Hero and closing call to action both lead to the walkthrough.
    expect(within(main).getAllByRole('link', { name: 'See how it works' }).map((a) => a.getAttribute('href'))).toEqual(['/how-it-works', '/how-it-works'])
    const how = within(main).getByRole('heading', { name: 'How it works' }).closest('section') as HTMLElement
    expect(within(how).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Connect your servers',
      'Describe the job',
      'Watch it run',
      'Turn alerts into postmortems',
    ])
    // Each step's shot is framed with its console URL and has a capture for every theme.
    const fleet = within(how).getAllByRole('img', { name: /^Fleet: four servers/ })
    expect(fleet.map((img) => img.className)).toEqual(['shot-img shot-routini', 'shot-img shot-light', 'shot-img shot-dark'])
    expect(fleet.every((img) => img.getAttribute('src') && img.getAttribute('loading') === 'lazy')).toBe(true)
    expect(within(how).getByText('routini.tynhub.com/o/northwind/fleet')).toBeTruthy()
    expect(within(how).getByRole('link', { name: /The full walkthrough/ }).getAttribute('href')).toBe('/how-it-works')
    expect(within(screen.getByRole('navigation', { name: 'Site' })).getByRole('link', { name: 'How it works' }).getAttribute('href')).toBe('/how-it-works')
  })

  it('installs a server with agents enabled', async () => {
    mockFetch(signedOut())
    renderAt('/')
    const main = await screen.findByRole('main')
    fireEvent.click(await within(main).findByRole('tab', { name: 'Connect a server' }))
    expect(within(main).getByLabelText('Connect a server').textContent).toContain('--enable-agents')
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
    // The landing page now renders first (visitors never see a loading gate), so the
    // console mounts only once the session resolves — give that transition more than
    // findByRole's 1000ms default.
    expect(await screen.findByRole('heading', { name: 'Inbox' }, { timeout: 5000 })).toBeTruthy()
  })
})

describe('how it works', () => {
  it('is the one walkthrough: setup in order, screenshots and the commands to copy', async () => {
    mockFetch(signedOut())
    renderAt('/how-it-works')
    expect(await screen.findByRole('heading', { level: 1, name: 'How Routini works' })).toBeTruthy()
    const toc = screen.getByRole('complementary', { name: 'On this page' })
    const links = within(toc).getAllByRole('link')
    expect(links.map((a) => a.textContent)).toEqual([
      'Create your account',
      'Add a model key',
      'Connect your servers',
      'Describe the job',
      'Set the guardrails',
      'Approve what matters',
      'Watch it run',
      'Turn alerts into postmortems',
      'Connect your tools',
      'Keep an environment',
      'Use Routini from Claude Code',
      'Run it yourself',
    ])
    // The old guide's anchors are all still here, so its links keep working.
    const ids = links.map((a) => a.getAttribute('href'))
    for (const old of ['#account', '#model', '#server', '#job', '#integrations', '#environments', '#guardrails', '#alerts', '#mcp', '#self-host']) expect(ids).toContain(old)

    const run = document.getElementById('run') as HTMLElement
    expect(within(run).getByText('Runs → a run')).toBeTruthy()
    expect(within(run).getAllByRole('img', { name: /Disk runbook/ })).toHaveLength(3)
    // Every screenshot step has a real capture in every theme (none fall back to a placeholder).
    expect(document.querySelectorAll('.shot-missing')).toHaveLength(0)
    expect(document.querySelectorAll('img.shot-img')).toHaveLength(7 * 3)

    // The commands from the old guide.
    expect(within(document.getElementById('server') as HTMLElement).getByText(/install\.sh/).textContent).toContain('--enable-agents')
    expect(screen.getByText(/claude mcp add --transport http routini/)).toBeTruthy()
    expect(screen.getByText(/make local/)).toBeTruthy()
    const create = (await screen.findAllByRole('link', { name: 'Create your account' })).find((a) => a.getAttribute('href') === '/signup')
    expect(create).toBeTruthy()
  })
})

describe('pricing', () => {
  it('shows the three plans and their real limits', async () => {
    mockFetch(signedOut())
    renderAt('/pricing')
    expect(await screen.findByRole('heading', { level: 1, name: 'Pricing' })).toBeTruthy()
    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { name: 'Self-hosted' })).toBeTruthy()
    expect(within(main).getByRole('heading', { name: 'Hosted alpha' })).toBeTruthy()
    expect(within(main).getByRole('heading', { name: 'Hosted paid' })).toBeTruthy()
    expect(within(main).getAllByText(/120 agent minutes a day/).length).toBeGreaterThan(0)
    expect(within(main).getByRole('link', { name: 'Run it yourself' }).getAttribute('href')).toBe('/how-it-works#self-host')
    expect(within(main).getByRole('link', { name: 'Get started, free' }).getAttribute('href')).toBe('/signup')
    expect(within(main).getByText('Can I move from hosted to self-hosted?')).toBeTruthy()
  })

  it('offers sign in instead of sign up when the server has signup closed', async () => {
    mockFetch(signedOut(false))
    renderAt('/pricing')
    const main = await screen.findByRole('main')
    expect((await within(main).findAllByRole('link', { name: 'Sign in' })).length).toBeGreaterThan(0)
    expect(within(main).queryByRole('link', { name: /Get started/ })).toBeNull()
  })
})

describe('privacy and terms', () => {
  it('renders the privacy policy with one h1 and a last-updated line', async () => {
    mockFetch(signedOut())
    renderAt('/privacy')
    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy policy' })).toBeTruthy()
    expect(screen.getByText(/Last updated: October 2026/)).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: 'What we store' })).toBeTruthy()
  })

  it('renders the terms of service with one h1', async () => {
    mockFetch(signedOut())
    renderAt('/terms')
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of service' })).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: 'Acceptable use' })).toBeTruthy()
  })
})

describe('not found', () => {
  it('shows a 404 page with links back into the site for an unknown path', async () => {
    mockFetch(signedOut())
    renderAt('/this-page-does-not-exist')
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy()
    const main = screen.getByRole('main')
    expect(within(main).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/')
    expect(within(main).getByRole('link', { name: 'How it works' }).getAttribute('href')).toBe('/how-it-works')
    expect(within(main).getByRole('link', { name: 'Pricing' }).getAttribute('href')).toBe('/pricing')
  })

  it('no longer has a client route for the old getting-started URL — nginx 301s it instead', async () => {
    mockFetch(signedOut())
    renderAt('/docs/getting-started')
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy()
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
