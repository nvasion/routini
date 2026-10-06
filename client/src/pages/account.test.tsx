// Phase 5 account screens: forgot/reset password, email verification (page and
// console banner), and deleting the account.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { baseRoutes, FakeEventSource, mockFetch, renderAt, SESSION } from '../test/harness'

const SIGNED_OUT = { 'GET /api/auth/me': () => [401, { error: 'Authentication required' }] as [number, unknown] }
const UNVERIFIED = { ...SESSION, user: { ...SESSION.user, emailVerified: false } }

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('password reset', () => {
  it('links to it from sign-in only when the server sends mail', async () => {
    mockFetch({ ...SIGNED_OUT, 'GET /api/auth/providers': () => ({ oidc: null, mail: true }) })
    renderAt('/login')
    expect(await screen.findByRole('link', { name: 'Forgot password?' })).toBeTruthy()
    cleanup()
    mockFetch({ ...SIGNED_OUT, 'GET /api/auth/providers': () => ({ oidc: null, mail: false }) })
    renderAt('/login')
    await screen.findByRole('button', { name: 'Sign in' })
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Forgot password?' })).toBeNull())
  })

  it('requests a link and shows the neutral answer', async () => {
    const log = mockFetch({ ...SIGNED_OUT, 'POST /api/auth/password/forgot': () => ({ message: 'If an account exists for that email, we sent a link.' }) })
    renderAt('/forgot-password')
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'kv@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/If an account exists/)
    expect(log.calls.find((c) => c.url === '/api/auth/password/forgot')?.body).toEqual({ email: 'kv@example.com' })
  })

  it('sets the new password from the link and returns to sign-in', async () => {
    const log = mockFetch({ ...SIGNED_OUT, 'POST /api/auth/password/reset': () => ({ message: 'ok' }), 'GET /api/auth/providers': () => ({ oidc: null }) })
    renderAt('/reset-password?token=tok123')
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'brand-new-pass' } })
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'different-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/don't match/)

    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'brand-new-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/Password changed/)
    expect(log.calls.find((c) => c.url === '/api/auth/password/reset')?.body).toEqual({ token: 'tok123', password: 'brand-new-pass' })
  })

  it('offers a new link when the token has expired', async () => {
    mockFetch({ ...SIGNED_OUT, 'POST /api/auth/password/reset': () => [400, { error: 'This reset link is invalid or has expired' }] })
    renderAt('/reset-password?token=old')
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'brand-new-pass' } })
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'brand-new-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }))
    expect(await screen.findByRole('link', { name: 'Request a new link' })).toBeTruthy()
  })
})

describe('email verification', () => {
  it('verifies the token once and refreshes the session', async () => {
    let verified = false
    const log = mockFetch({
      'GET /api/auth/me': () => (verified ? SESSION : UNVERIFIED),
      'POST /api/auth/email/verify': () => ((verified = true), { message: 'Email verified' }),
    })
    renderAt('/verify-email?token=v1')
    expect((await screen.findByRole('status')).textContent).toMatch(/Your email is verified/)
    expect(log.calls.filter((c) => c.url === '/api/auth/email/verify')).toHaveLength(1)
    expect(await screen.findByRole('link', { name: 'Open the console' })).toBeTruthy()
  })

  it('nags in the console only when the server gates on it, and resends', async () => {
    const log = mockFetch(
      baseRoutes({
        'GET /api/auth/me': () => UNVERIFIED,
        'GET /api/auth/providers': () => ({ oidc: null, mail: true, emailVerification: true }),
        'POST /api/auth/email/resend': () => ({ message: 'Verification email sent to kv@example.com' }),
      }),
    )
    renderAt('/o/acme/inbox')
    fireEvent.click(await screen.findByRole('button', { name: 'Resend email' }))
    await screen.findByText('Verification email sent to kv@example.com')
    expect(log.calls.some((c) => c.method === 'POST' && c.url === '/api/auth/email/resend')).toBe(true)
    cleanup()

    mockFetch(baseRoutes({ 'GET /api/auth/me': () => UNVERIFIED, 'GET /api/auth/providers': () => ({ oidc: null, mail: false, emailVerification: false }) }))
    renderAt('/o/acme/inbox')
    await screen.findByRole('heading', { name: 'Inbox' })
    expect(screen.queryByRole('button', { name: 'Resend email' })).toBeNull()
  })
})

describe('delete account', () => {
  it('asks to confirm the orgs it deletes, then signs out', async () => {
    const log = mockFetch(
      baseRoutes({
        'GET /api/auth/providers': () => ({ oidc: null, mail: true }),
        'DELETE /api/auth/account': ({ body }) =>
          (body as { deleteOrgs: boolean }).deleteOrgs
            ? { message: 'Account deleted', deletedOrgs: ['acme'] }
            : [409, { error: 'Deleting your account also deletes these orgs', code: 'confirm_org_deletion', orgs: [{ slug: 'acme', name: 'Acme' }] }],
        'POST /api/auth/logout': () => ({ message: 'Logged out' }),
      }),
    )
    renderAt('/o/acme/settings/account')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account…' }))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const confirm = await screen.findByRole('checkbox')
    expect(screen.getByText(/Also delete Acme/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Delete account' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    await waitFor(() => expect(log.calls.some((c) => c.url === '/api/auth/logout')).toBe(true))
    const deletes = log.calls.filter((c) => c.method === 'DELETE' && c.url === '/api/auth/account')
    expect(deletes.map((c) => (c.body as { deleteOrgs: boolean }).deleteOrgs)).toEqual([false, true])
  })
})
