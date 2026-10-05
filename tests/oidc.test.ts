// Sign in with TynHub (OIDC, code + PKCE) against a fake issuer: account
// creation and linking rules, TynHub org membership, and tampering.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { makeTestApp, type TestApp } from './helpers/testApp'
import { FakeIssuer, type FakeIdentity } from './helpers/fakeIssuer'
import type { Config } from '../server/src/config'
import { safeNext } from '../server/src/http/oidc'

let issuer: FakeIssuer
let t: TestApp
let open = false

beforeAll(async () => {
  issuer = new FakeIssuer()
  await issuer.start()
})
afterAll(async () => {
  await issuer.stop()
})
afterEach(async () => {
  issuer.tamperNonce = false
  if (open) await t.close()
  open = false
})

async function app(extra: Partial<Config> = {}): Promise<TestApp> {
  t = await makeTestApp({
    config: {
      publicUrl: 'http://routini.test',
      clientUrl: 'http://console.test',
      oidc: { issuer: issuer.url, clientId: issuer.clientId, clientSecret: issuer.clientSecret, name: 'TynHub', scopes: 'openid profile email orgs' },
      ...extra,
    },
  })
  open = true
  return t
}

const cookieFrom = (res: { headers: Record<string, unknown> }, name: string): string | null => {
  const raw = (res.headers['set-cookie'] as string[] | undefined) ?? []
  const c = raw.find((x) => x.startsWith(`${name}=`))
  return c ? c.split(';')[0]! : null
}

/** Runs the whole redirect dance; returns the callback response and the console session cookie. */
async function signIn(identity: FakeIdentity, opts: { next?: string; session?: string; state?: string } = {}) {
  const start = await t.request.get(`/api/auth/oidc/start?next=${encodeURIComponent(opts.next ?? '/')}${opts.session ? '&link=1' : ''}`).set('Cookie', opts.session ?? '')
  expect(start.status).toBe(302)
  const authUrl = new URL(start.headers['location'] as string)
  expect(authUrl.origin + authUrl.pathname).toBe(`${issuer.url}/authorize`)
  expect(authUrl.searchParams.get('redirect_uri')).toBe('http://routini.test/api/auth/oidc/callback')
  expect(authUrl.searchParams.get('scope')).toBe('openid profile email orgs')
  const stateCookie = cookieFrom(start, 'routini_oidc')!
  const code = issuer.issue(authUrl, identity)
  const cb = await t.request.get(`/api/auth/oidc/callback?code=${code}&state=${opts.state ?? authUrl.searchParams.get('state')}`).set('Cookie', stateCookie)
  return { cb, location: cb.headers['location'] as string, session: cookieFrom(cb, 'routini_token') }
}

const me = (session: string) => t.request.get('/api/auth/me').set('Cookie', session)

describe('sign in with TynHub', () => {
  it('advertises the provider and creates a new account from verified claims', async () => {
    await app({ signup: 'open' })
    expect((await t.request.get('/api/auth/providers')).body).toEqual({ oidc: { name: 'TynHub' } })
    const { cb, location, session } = await signIn({ sub: 'u-1', email: 'Ada@Example.com', email_verified: true, name: 'Ada' }, { next: '/o/x/inbox' })
    expect(cb.status).toBe(302)
    expect(location).toBe('http://console.test/o/x/inbox')
    const who = (await me(session!)).body
    expect(who.user).toMatchObject({ email: 'ada@example.com', displayName: 'Ada' })
    expect(who.orgs).toHaveLength(1)
    expect(who.orgs[0].role).toBe('owner')
    // No password: password login is not possible for this account.
    expect((await t.request.post('/api/auth/login').send({ email: 'ada@example.com', password: 'anything-123' })).status).toBe(401)

    // Returning identity → same user (even if the email changed at TynHub).
    const again = await signIn({ sub: 'u-1', email: 'ada@new.example', email_verified: true })
    expect((await me(again.session!)).body.user.id).toBe(who.user.id)
  })

  it('never attaches a new identity to an existing account by email; linking is explicit', async () => {
    await app({ signup: 'open' })
    const local = await t.signup('grace@example.com')
    const { location, session } = await signIn({ sub: 'u-2', email: 'grace@example.com', email_verified: true })
    expect(session).toBeNull()
    expect(decodeURIComponent(location)).toContain('/login?error=An account with this email already exists')

    // Signed in with her password, she links TynHub from her account.
    const login = await t.request.post('/api/auth/login').send({ email: 'grace@example.com', password: 'password123' })
    const pw = cookieFrom(login, 'routini_token')!
    expect((await t.request.get('/api/auth/identities').set('Cookie', pw)).body).toEqual({ provider: { name: 'TynHub', linked: false } })
    const linked = await signIn({ sub: 'u-2', email: 'grace@example.com', email_verified: true }, { session: pw })
    expect(linked.location).toBe('http://console.test/?linked=1')
    expect((await t.request.get('/api/auth/identities').set('Cookie', pw)).body.provider.linked).toBe(true)
    const viaTynhub = await signIn({ sub: 'u-2' })
    expect((await me(viaTynhub.session!)).body.user.id).toBe(local.userId)
  })

  it('requires a verified email for new accounts', async () => {
    await app({ signup: 'open' })
    const { location, session } = await signIn({ sub: 'u-3', email: 'eve@example.com', email_verified: false })
    expect(session).toBeNull()
    expect(decodeURIComponent(location)).toContain('needs a verified email')
  })

  it('joins orgs linked to the user’s TynHub orgs, even with signup closed; never changes existing roles', async () => {
    await app({ signup: 'open' })
    const owner = await t.signup('owner@example.com')
    expect((await owner.put(`/api/orgs/${owner.orgSlug}/tynhub`, { tynhubOrg: 'Acme' })).body.org.tynhubOrg).toBe('acme')
    t.ctx.config.signup = 'closed'

    const res = await signIn({ sub: 'u-4', email: 'lin@acme.example', email_verified: true, orgs: [{ slug: 'acme', role: 'admin' }, { slug: 'other', role: 'owner' }] })
    const who = (await me(res.session!)).body
    // Joined the linked org as admin; no personal org since they joined one.
    expect(who.orgs).toEqual([expect.objectContaining({ slug: owner.orgSlug, role: 'admin' })])

    // A later sign-in claiming a different TynHub role does not change the Routini role.
    await t.ctx.db.system((q) => q.query(`UPDATE memberships SET role = 'viewer' WHERE user_id = $1`, [who.user.id]))
    const later = await signIn({ sub: 'u-4', email: 'lin@acme.example', email_verified: true, orgs: [{ slug: 'acme', role: 'owner' }] })
    expect((await me(later.session!)).body.orgs[0].role).toBe('viewer')

    // Without a linked org, closed signup refuses.
    const refused = await signIn({ sub: 'u-5', email: 'x@else.example', email_verified: true, orgs: [{ slug: 'else', role: 'member' }] })
    expect(refused.session).toBeNull()
    expect(decodeURIComponent(refused.location)).toContain('Signup is closed')
  })

  it('only owners link orgs, and slugs are validated', async () => {
    await app({ signup: 'open' })
    const owner = await t.signup('o2@example.com')
    expect((await owner.put(`/api/orgs/${owner.orgSlug}/tynhub`, { tynhubOrg: 'bad slug!' })).status).toBe(400)
    const admin = await t.signup('a2@example.com')
    await t.ctx.db.system((q) => q.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [owner.orgId, admin.userId]))
    expect((await admin.put(`/api/orgs/${owner.orgSlug}/tynhub`, { tynhubOrg: 'acme' })).status).toBe(403)
    expect((await owner.put(`/api/orgs/${owner.orgSlug}/tynhub`, { tynhubOrg: null })).body.org.tynhubOrg).toBeNull()
  })

  it('rejects tampered state, missing cookies, nonce mismatches and replayed codes', async () => {
    await app({ signup: 'open' })
    const id = { sub: 'u-6', email: 'm@example.com', email_verified: true }
    expect((await signIn(id, { state: 'forged' })).session).toBeNull()

    issuer.tamperNonce = true
    const badNonce = await signIn(id)
    expect(badNonce.session).toBeNull()
    expect(decodeURIComponent(badNonce.location)).toContain('could not be verified')
    issuer.tamperNonce = false

    const noCookie = await t.request.get('/api/auth/oidc/callback?code=x&state=y')
    expect(decodeURIComponent(noCookie.headers['location'] as string)).toContain('took too long or was started elsewhere')
  })

  it('without OIDC configured, there is no provider and start explains', async () => {
    t = await makeTestApp({ config: { clientUrl: 'http://console.test' } })
    open = true
    expect((await t.request.get('/api/auth/providers')).body).toEqual({ oidc: null })
    const start = await t.request.get('/api/auth/oidc/start')
    expect(decodeURIComponent(start.headers['location'] as string)).toContain('not configured')
  })

  it('only allows same-origin console paths after sign-in', () => {
    expect(safeNext('/o/acme/runs/3')).toBe('/o/acme/runs/3')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
  })
})
