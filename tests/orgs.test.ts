// Orgs, membership, roles and cross-org isolation over the API.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'

let t: TestApp
let owner: TestUser
let other: TestUser

beforeEach(async () => {
  t = await makeTestApp()
  owner = await t.signup('owner@example.com', { orgName: 'Acme' })
  other = await t.signup('other@example.com', { orgName: 'Globex' })
})
afterEach(() => t.close())

describe('isolation', () => {
  it('non-members get 404 for another org and all of its resources', async () => {
    for (const path of ['', '/members', '/settings', '/credentials', '/integrations']) {
      const res = await other.get(`/api/orgs/${owner.orgSlug}${path}`)
      expect(res.status, path).toBe(404)
    }
  })

  it('lists only my orgs', async () => {
    const res = await owner.get('/api/orgs')
    expect(res.body.orgs.map((o: { slug: string }) => o.slug)).toEqual(['acme'])
  })
})

describe('orgs', () => {
  it('creates an org with the caller as owner', async () => {
    const res = await owner.post('/api/orgs', { name: 'Second Org', slug: 'second' })
    expect(res.status).toBe(201)
    expect(res.body.org).toMatchObject({ slug: 'second', role: 'owner' })
    expect((await owner.get('/api/orgs')).body.orgs).toHaveLength(2)
  })

  it('reports when a requested slug was taken', async () => {
    const res = await owner.post('/api/orgs', { name: 'Clash', slug: 'globex' })
    expect(res.status).toBe(201)
    expect(res.body.org.slug).toBe('globex-2')
    expect(res.body.note).toMatch(/taken/)
  })

  it('validates name and slug', async () => {
    expect((await owner.post('/api/orgs', { name: '' })).status).toBe(400)
    expect((await owner.post('/api/orgs', { name: 'X', slug: '-bad-' })).status).toBe(400)
  })

  it('limits overrides can tighten but never loosen plan limits', async () => {
    // Hosted orgs are on the free plan: 2 concurrent runs, 120 agent minutes/day.
    t.ctx.config.mode = 'hosted'
    const hosted = await t.signup('hosted@example.com')
    const loosen = await hosted.put(`/api/orgs/${hosted.orgSlug}`, { limits: { maxConcurrentRuns: 50, agentMinutesPerDay: 9999 } })
    expect(loosen.status).toBe(200)
    expect(loosen.body.org.limits).toMatchObject({ maxConcurrentRuns: 2, agentMinutesPerDay: 120 })
    const tighten = await hosted.put(`/api/orgs/${hosted.orgSlug}`, { limits: { maxConcurrentRuns: 1, dailyBudgetUsd: 5 } })
    expect(tighten.body.org.limits).toMatchObject({ maxConcurrentRuns: 1, agentMinutesPerDay: 120, dailyBudgetUsd: 5 })
  })
})

describe('members and roles', () => {
  const members = (slug: string) => `/api/orgs/${slug}/members`

  it('admins add existing users by email; unknown emails 404', async () => {
    const add = await owner.post(members(owner.orgSlug), { email: 'other@example.com', role: 'member' })
    expect(add.status).toBe(201)
    expect(add.body.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ['owner@example.com', 'owner'],
      ['other@example.com', 'member'],
    ])
    expect((await owner.post(members(owner.orgSlug), { email: 'nobody@example.com' })).status).toBe(404)
    expect((await owner.post(members(owner.orgSlug), { email: 'other@example.com' })).status).toBe(409)
    // The new member can now see the org.
    expect((await other.get(`/api/orgs/${owner.orgSlug}`)).body.org.role).toBe('member')
  })

  it('members cannot administer', async () => {
    await owner.post(members(owner.orgSlug), { email: 'other@example.com', role: 'member' })
    expect((await other.put(`/api/orgs/${owner.orgSlug}`, { name: 'Hijack' })).status).toBe(403)
    expect((await other.post(members(owner.orgSlug), { email: 'owner@example.com' })).status).toBe(403)
    expect((await other.put(`/api/orgs/${owner.orgSlug}/settings`, {})).status).toBe(403)
  })

  it('admins cannot grant or remove the owner role', async () => {
    await owner.post(members(owner.orgSlug), { email: 'other@example.com', role: 'admin' })
    const third = await t.signup('third@example.com')
    expect((await other.post(members(owner.orgSlug), { email: 'third@example.com', role: 'owner' })).status).toBe(403)
    expect((await other.del(`${members(owner.orgSlug)}/${owner.userId}`)).status).toBe(403)
    expect((await other.post(members(owner.orgSlug), { email: 'third@example.com', role: 'viewer' })).status).toBe(201)
    expect(third.userId).toBeTruthy()
  })

  it('an org always keeps one owner', async () => {
    expect((await owner.put(`${members(owner.orgSlug)}/${owner.userId}`, { role: 'admin' })).status).toBe(400)
    expect((await owner.del(`${members(owner.orgSlug)}/${owner.userId}`)).status).toBe(400)
    await owner.post(members(owner.orgSlug), { email: 'other@example.com', role: 'owner' })
    expect((await owner.put(`${members(owner.orgSlug)}/${owner.userId}`, { role: 'admin' })).status).toBe(200)
  })

  it('viewers can read but not write', async () => {
    await owner.post(members(owner.orgSlug), { email: 'other@example.com', role: 'viewer' })
    expect((await other.get(`/api/orgs/${owner.orgSlug}/settings`)).status).toBe(200)
    expect((await other.put(`/api/orgs/${owner.orgSlug}/credentials/x`, { value: 'v' })).status).toBe(403)
  })
})
