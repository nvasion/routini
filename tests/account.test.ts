// Account basics: email verification (and the gate on agents/environments),
// password reset with session revocation, and account deletion.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { FakeEnvRuntime } from './helpers/fakeEnvRuntime'
import { Worker } from '../server/src/engine/worker'
import { agentExecutor } from '../server/src/engine/agent'
import { issueAuthToken } from '../server/src/repos/authTokens'
import { buildAccountEmail } from '../server/src/services/email'

let t: TestApp
afterEach(async () => {
  await t?.close()
  t = undefined as unknown as TestApp
})

interface Sent {
  to: string
  subject: string
  text: string
  html: string
}

/** A test app whose account emails land in `sent`. */
async function appWithMail(opts: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp(opts)
  const sent: Sent[] = []
  t.ctx.mailer = { sendMail: vi.fn(async (m: Sent) => (sent.push(m), {})) }
  return { sent }
}

const tokenIn = (mail: Sent | undefined): string => {
  const m = /token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')
  if (!m) throw new Error(`no token in ${JSON.stringify(mail)}`)
  return m[1]!
}

/** Waits for the n-th email (signup and forgot-password send without awaiting). */
async function nth(sent: Sent[], n: number): Promise<Sent> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(n))
  return sent[n - 1]!
}

describe('email verification', () => {
  it('emails a link on signup that verifies the account once', async () => {
    const { sent } = await appWithMail()
    const signup = await t.request.post('/api/auth/signup').send({ email: 'ver@example.com', password: 'password123' })
    expect(signup.body.user.emailVerified).toBe(false)
    const mail = await nth(sent, 1)
    expect(mail).toMatchObject({ to: 'ver@example.com', subject: 'Verify your email for Routini' })
    expect(mail.text).toContain('http://localhost:5173/verify-email?token=')

    const token = tokenIn(mail)
    expect((await t.request.post('/api/auth/email/verify').send({ token })).status).toBe(200)
    const me = await t.request.get('/api/auth/me').set('Authorization', `Bearer ${signup.body.token}`)
    expect(me.body.user.emailVerified).toBe(true)
    expect((await t.request.post('/api/auth/email/verify').send({ token })).status).toBe(400)
  })

  it('stores only a hash of each token and refuses expired ones', async () => {
    await appWithMail()
    const u = await t.signup('exp@example.com')
    const token = await issueAuthToken(t.ctx.db, u.userId, 'verify')
    const rows = await t.ctx.db.query<{ token_hash: string }>('SELECT token_hash FROM auth_tokens WHERE user_id = $1', [u.userId])
    expect(rows.map((r) => r.token_hash)).not.toContain(token)
    await t.ctx.db.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u.userId])
    const res = await t.request.post('/api/auth/email/verify').send({ token })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid or has expired/)
  })

  it('resends on request, at most three emails an hour', async () => {
    const { sent } = await appWithMail()
    const u = await t.signup('resend@example.com')
    await nth(sent, 1)
    expect((await u.post('/api/auth/email/resend')).status).toBe(200)
    expect((await u.post('/api/auth/email/resend')).status).toBe(200)
    const limited = await u.post('/api/auth/email/resend')
    expect(limited.status).toBe(429)
    expect(sent).toHaveLength(3)

    await t.request.post('/api/auth/email/verify').send({ token: tokenIn(sent[2]) })
    expect((await u.post('/api/auth/email/resend')).body.message).toMatch(/already verified/)
  })

  it('escapes the link in the HTML body', () => {
    const { html } = buildAccountEmail({ to: 'a@b.co', subject: 's', intro: 'Hi <b>', action: 'Go', url: 'https://x.test/?token=a"b', outro: 'o' })
    expect(html).toContain('Hi &lt;b&gt;')
    expect(html).toContain('token=a&quot;b')
  })
})

describe('the verified-email gate', () => {
  it('blocks environments and agent steps until an owner verifies', async () => {
    const rt = new FakeEnvRuntime()
    const docker = { runStreaming: vi.fn(async () => { throw new Error('the gate should stop this first') }), killByLabels: async () => 0 }
    const { sent } = await appWithMail({ config: { requireVerifiedEmail: true }, envRuntime: rt, engine: { executors: { agent: agentExecutor({ docker }) } } })
    const u = await t.signup('gate@example.com')
    const base = `/api/orgs/${u.orgSlug}`

    const env = await u.post(`${base}/environments`, { name: 'dev' })
    expect(env.status).toBe(403)
    expect(env.body.error).toMatch(/Verify your email address/)

    const job = await u.post(`${base}/jobs`, { name: 'Agent', steps: [{ name: 'agent', kind: 'agent', config: { agent: 'claude', prompt: 'Hi' } }] })
    const run = await u.post(`${base}/jobs/${job.body.job.id}/run`)
    await new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()
    const detail = (await u.get(`${base}/runs/${run.body.run.number}`)).body
    expect(detail.run.status).toBe('failed')
    expect(detail.steps[0].error).toMatch(/email_unverified/)
    expect(docker.runStreaming).not.toHaveBeenCalled()

    await t.request.post('/api/auth/email/verify').send({ token: tokenIn(await nth(sent, 1)) })
    expect((await u.post(`${base}/environments`, { name: 'dev' })).status).toBe(202)
  })

  it('is off by default outside hosted mode with SMTP', async () => {
    t = await makeTestApp({ envRuntime: new FakeEnvRuntime() })
    expect(t.ctx.config.requireVerifiedEmail).toBe(false)
    const u = await t.signup('open@example.com')
    expect((await u.post(`/api/orgs/${u.orgSlug}/environments`, { name: 'dev' })).status).toBe(202)
  })
})

describe('password reset', () => {
  async function forgot(email: string) {
    return t.request.post('/api/auth/password/forgot').send({ email })
  }

  it('answers the same for known and unknown emails, and only emails real accounts', async () => {
    const { sent } = await appWithMail()
    await t.signup('known@example.com')
    await nth(sent, 1)
    const known = await forgot('KNOWN@example.com')
    const unknown = await forgot('nobody@example.com')
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(known.body).toEqual(unknown.body)
    const mail = await nth(sent, 2)
    expect(mail).toMatchObject({ to: 'known@example.com', subject: 'Reset your Routini password' })
    expect(mail.text).toContain('/reset-password?token=')
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toHaveLength(2)
  })

  it('sets the new password, revokes every session, and works once', async () => {
    const { sent } = await appWithMail()
    const u = await t.signup('reset@example.com')
    const other = await t.signup('bystander@example.com')
    await nth(sent, 2)
    await forgot('reset@example.com')
    const token = tokenIn(await nth(sent, 3))

    expect((await t.request.post('/api/auth/password/reset').send({ token, password: 'short' })).status).toBe(400)
    const res = await t.request.post('/api/auth/password/reset').send({ token, password: 'brand-new-password' })
    expect(res.status).toBe(200)

    expect((await u.get('/api/auth/me')).status).toBe(401)
    expect((await other.get('/api/auth/me')).status).toBe(200)
    expect((await t.request.post('/api/auth/login').send({ email: 'reset@example.com', password: 'password123' })).status).toBe(401)
    const login = await t.request.post('/api/auth/login').send({ email: 'reset@example.com', password: 'brand-new-password' })
    expect(login.status).toBe(200)
    // The emailed link also proved the address.
    expect(login.body.user.emailVerified).toBe(true)
    expect((await t.request.get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`)).status).toBe(200)

    expect((await t.request.post('/api/auth/password/reset').send({ token, password: 'another-password' })).status).toBe(400)
  })

  it('refuses expired links, verification links, and older links after a reset', async () => {
    const { sent } = await appWithMail()
    const u = await t.signup('links@example.com')
    const verifyToken = tokenIn(await nth(sent, 1))
    expect((await t.request.post('/api/auth/password/reset').send({ token: verifyToken, password: 'brand-new-password' })).status).toBe(400)

    await forgot('links@example.com')
    await forgot('links@example.com')
    const first = tokenIn(await nth(sent, 2))
    const second = tokenIn(await nth(sent, 3))
    expect((await t.request.post('/api/auth/password/reset').send({ token: second, password: 'brand-new-password' })).status).toBe(200)
    expect((await t.request.post('/api/auth/password/reset').send({ token: first, password: 'other-password-1' })).status).toBe(400)

    const expired = await issueAuthToken(t.ctx.db, u.userId, 'reset')
    await t.ctx.db.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`)
    expect((await t.request.post('/api/auth/password/reset').send({ token: expired, password: 'other-password-2' })).status).toBe(400)
  })

  it('emails an account at most three reset links an hour', async () => {
    const { sent } = await appWithMail()
    await t.signup('flood@example.com')
    await nth(sent, 1)
    for (let i = 0; i < 5; i++) expect((await forgot('flood@example.com')).status).toBe(200)
    await nth(sent, 4)
    await new Promise((r) => setTimeout(r, 50))
    expect(sent).toHaveLength(4)
  })
})

describe('delete account', () => {
  const del = (u: TestUser, body: Record<string, unknown>) => u.del('/api/auth/account').send(body)

  it('needs the password, then confirmation for the orgs it takes with it', async () => {
    const rt = new FakeEnvRuntime()
    t = await makeTestApp({ envRuntime: rt })
    const u = await t.signup('leaver@example.com')
    const env = await u.post(`/api/orgs/${u.orgSlug}/environments`, { name: 'dev' })
    expect(env.status).toBe(202)
    await t.ctx.envs.idle()
    expect(rt.volumes.size).toBe(1)

    expect((await del(u, { password: 'wrong-password' })).status).toBe(403)
    const confirm = await del(u, { password: 'password123' })
    expect(confirm.status).toBe(409)
    expect(confirm.body).toMatchObject({ code: 'confirm_org_deletion', orgs: [{ slug: u.orgSlug }] })

    const res = await del(u, { password: 'password123', deleteOrgs: true })
    expect(res.status).toBe(200)
    expect(res.body.deletedOrgs).toEqual([u.orgSlug])
    expect(rt.volumes.size).toBe(0)
    expect([...rt.containers.values()].filter((c) => c.running)).toHaveLength(0)
    expect(await t.ctx.db.query('SELECT 1 FROM orgs WHERE id = $1', [u.orgId])).toHaveLength(0)
    expect(await t.ctx.db.system((q) => q.query('SELECT 1 FROM environments WHERE org_id = $1', [u.orgId]))).toHaveLength(0)
    expect((await t.request.post('/api/auth/login').send({ email: 'leaver@example.com', password: 'password123' })).status).toBe(401)
    expect((await u.get('/api/auth/me')).status).toBe(401)
  })

  it('leaves orgs with other owners alone and asks for a new owner where needed', async () => {
    t = await makeTestApp()
    const owner = await t.signup('owner@example.com')
    const member = await t.signup('member@example.com')
    await t.ctx.db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.orgId, member.userId])

    const blocked = await del(owner, { password: 'password123', deleteOrgs: true })
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ code: 'transfer_ownership', orgs: [{ slug: owner.orgSlug }] })

    await t.ctx.db.query(`UPDATE memberships SET role = 'owner' WHERE org_id = $1 AND user_id = $2`, [owner.orgId, member.userId])
    expect((await del(owner, { password: 'password123', deleteOrgs: true })).status).toBe(200)
    expect(await t.ctx.db.query('SELECT 1 FROM orgs WHERE id = $1', [owner.orgId])).toHaveLength(1)
    expect((await member.get(`/api/orgs/${owner.orgSlug}`)).status).toBe(200)
  })

  it('refuses API tokens and orgs with runs in progress', async () => {
    t = await makeTestApp()
    const u = await t.signup('busy@example.com')
    const tok = await u.post(`/api/orgs/${u.orgSlug}/tokens`, { name: 'script', role: 'admin' })
    expect(tok.status, JSON.stringify(tok.body)).toBe(201)
    const viaToken = await t.request.delete('/api/auth/account').set('Authorization', `Bearer ${tok.body.token}`).send({ password: 'password123', deleteOrgs: true })
    expect(viaToken.status).toBe(403)

    const job = await u.post(`/api/orgs/${u.orgSlug}/jobs`, { name: 'Wait', steps: [{ name: 'ok', kind: 'approval', config: { message: 'Go?' } }] })
    expect(job.status, JSON.stringify(job.body)).toBe(201)
    await u.post(`/api/orgs/${u.orgSlug}/jobs/${job.body.job.id}/run`)
    const res = await del(u, { password: 'password123', deleteOrgs: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/runs in progress/)
  })
})

describe('config', () => {
  it('requires verification by default only in hosted mode with SMTP', async () => {
    const { loadConfig } = await import('../server/src/config')
    expect(loadConfig({ NODE_ENV: 'test', ROUTINI_MODE: 'hosted', SMTP_HOST: 'smtp.resend.com' }).requireVerifiedEmail).toBe(true)
    expect(loadConfig({ NODE_ENV: 'test', ROUTINI_MODE: 'hosted' }).requireVerifiedEmail).toBe(false)
    expect(loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.resend.com' }).requireVerifiedEmail).toBe(false)
    expect(loadConfig({ NODE_ENV: 'test', ROUTINI_MODE: 'hosted', SMTP_HOST: 'smtp.resend.com', ROUTINI_REQUIRE_VERIFIED_EMAIL: 'false' }).requireVerifiedEmail).toBe(false)
    expect(loadConfig({ NODE_ENV: 'test', ROUTINI_REQUIRE_VERIFIED_EMAIL: 'true' }).requireVerifiedEmail).toBe(true)
  })
})
