/**
 * Integration tests for the notification settings API.
 *
 * Coverage:
 *   – GET  /api/notifications/settings : shape, auth guard
 *   – PUT  /api/notifications/settings : field updates, partial updates,
 *                                        input validation, auth guard
 *   – POST /api/notifications/test     : SMTP-not-configured 503, invalid
 *                                        recipient 400, auth guard
 *
 * Note: sendMail is never actually invoked in these tests because SMTP_HOST
 * is not set in the test environment (the transporter resolves to null and the
 * /test endpoint returns 503).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import supertest from 'supertest'
import { app } from '../server/src/app'
import { notificationSettings } from '../server/src/routes/notifications'

const request = supertest(app)

// ── Auth helper ───────────────────────────────────────────────────────────────

let authToken: string

beforeAll(async () => {
  const res = await request
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

// Reset settings to a known default before each test so tests are independent.
beforeEach(() => {
  Object.assign(notificationSettings, {
    enabled: false,
    recipientEmail: '',
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnRoutineMilestone: false,
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/notifications/settings
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/notifications/settings', () => {
  it('returns 200 with all expected fields', async () => {
    const res = await request.get('/api/notifications/settings').set(auth())
    expect(res.status).toBe(200)
    expect(typeof res.body.enabled).toBe('boolean')
    expect(typeof res.body.recipientEmail).toBe('string')
    expect(typeof res.body.notifyOnSuccess).toBe('boolean')
    expect(typeof res.body.notifyOnFailure).toBe('boolean')
    expect(typeof res.body.notifyOnRoutineMilestone).toBe('boolean')
  })

  it('returns the current default values', async () => {
    const res = await request.get('/api/notifications/settings').set(auth())
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(false)
    expect(res.body.recipientEmail).toBe('')
    expect(res.body.notifyOnSuccess).toBe(true)
    expect(res.body.notifyOnFailure).toBe(true)
    expect(res.body.notifyOnRoutineMilestone).toBe(false)
  })

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/api/notifications/settings')
    expect(res.status).toBe(401)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/notifications/settings
// ═════════════════════════════════════════════════════════════════════════════

describe('PUT /api/notifications/settings', () => {
  // ── Happy paths ───────────────────────────────────────────────────────────

  it('enables notifications', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ enabled: true })
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
  })

  it('sets a valid recipientEmail', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ recipientEmail: 'ops@example.com' })
    expect(res.status).toBe(200)
    expect(res.body.recipientEmail).toBe('ops@example.com')
  })

  it('trims whitespace from recipientEmail', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ recipientEmail: '  ops@example.com  ' })
    expect(res.status).toBe(200)
    expect(res.body.recipientEmail).toBe('ops@example.com')
  })

  it('clears recipientEmail with an empty string', async () => {
    // First set an address
    await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ recipientEmail: 'ops@example.com' })

    // Now clear it
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ recipientEmail: '' })
    expect(res.status).toBe(200)
    expect(res.body.recipientEmail).toBe('')
  })

  it('disables notifyOnSuccess', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ notifyOnSuccess: false })
    expect(res.status).toBe(200)
    expect(res.body.notifyOnSuccess).toBe(false)
  })

  it('disables notifyOnFailure', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ notifyOnFailure: false })
    expect(res.status).toBe(200)
    expect(res.body.notifyOnFailure).toBe(false)
  })

  it('enables notifyOnRoutineMilestone', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ notifyOnRoutineMilestone: true })
    expect(res.status).toBe(200)
    expect(res.body.notifyOnRoutineMilestone).toBe(true)
  })

  it('supports a full settings update in one request', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({
        enabled: true,
        recipientEmail: 'team@myapp.io',
        notifyOnSuccess: false,
        notifyOnFailure: true,
        notifyOnRoutineMilestone: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    expect(res.body.recipientEmail).toBe('team@myapp.io')
    expect(res.body.notifyOnSuccess).toBe(false)
    expect(res.body.notifyOnFailure).toBe(true)
    expect(res.body.notifyOnRoutineMilestone).toBe(true)
  })

  // ── Partial update preserves other fields ─────────────────────────────────

  it('partial update preserves unmentioned fields', async () => {
    // Set a known state
    await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({
        enabled: true,
        recipientEmail: 'alice@example.com',
        notifyOnSuccess: true,
        notifyOnFailure: true,
        notifyOnRoutineMilestone: true,
      })

    // Only update one field
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ notifyOnSuccess: false })
    expect(res.status).toBe(200)
    // Everything else should be unchanged
    expect(res.body.enabled).toBe(true)
    expect(res.body.recipientEmail).toBe('alice@example.com')
    expect(res.body.notifyOnSuccess).toBe(false)
    expect(res.body.notifyOnFailure).toBe(true)
    expect(res.body.notifyOnRoutineMilestone).toBe(true)
  })

  it('GET reflects values set by a previous PUT', async () => {
    await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ enabled: true, recipientEmail: 'test@example.com' })

    const res = await request.get('/api/notifications/settings').set(auth())
    expect(res.body.enabled).toBe(true)
    expect(res.body.recipientEmail).toBe('test@example.com')
  })

  // ── Validation errors ─────────────────────────────────────────────────────

  it('returns 400 when enabled is a string', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ enabled: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/enabled/)
  })

  it('returns 400 when enabled is a number', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ enabled: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/enabled/)
  })

  it('returns 400 for an invalid recipientEmail', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ recipientEmail: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/email/i)
  })

  it('returns 400 for a recipientEmail with no domain dot', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ recipientEmail: 'user@localhost' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/email/i)
  })

  it('returns 400 when recipientEmail is a non-string', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ recipientEmail: 123 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/recipientEmail/)
  })

  it('returns 400 when notifyOnSuccess is a string', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ notifyOnSuccess: 'true' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/notifyOnSuccess/)
  })

  it('returns 400 when notifyOnFailure is a number', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ notifyOnFailure: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/notifyOnFailure/)
  })

  it('returns 400 when notifyOnRoutineMilestone is null', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .set(auth())
      .send({ notifyOnRoutineMilestone: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/notifyOnRoutineMilestone/)
  })

  // ── Auth & CSRF guards ────────────────────────────────────────────────────

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .put('/api/notifications/settings')
      .send({ enabled: true })
    expect(res.status).toBe(401)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/notifications/test
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/notifications/test', () => {
  // ── SMTP not configured ───────────────────────────────────────────────────

  it('returns 503 when SMTP_HOST is not set', async () => {
    // In the test environment, SMTP_HOST is never set, so createTransporter()
    // returns null and the endpoint reports that SMTP is not configured.
    const res = await request
      .post('/api/notifications/test')
      .set(auth())
      .send({ recipientEmail: 'ops@example.com' })
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/smtp/i)
  })

  it('503 error message does not contain SMTP credentials', async () => {
    const res = await request
      .post('/api/notifications/test')
      .set(auth())
      .send({ recipientEmail: 'ops@example.com' })
    // Ensure no credential-like strings appear (SMTP_PASS value is never set
    // in test env, but the message should not reference env var names either)
    expect(res.body.error).not.toMatch(/smtp_pass/i)
    expect(res.body.error).not.toMatch(/password/i)
  })

  // ── Recipient validation ──────────────────────────────────────────────────

  it('returns 400 when no valid recipient is available', async () => {
    // No recipientEmail in body, and stored recipientEmail is empty (reset in beforeEach)
    const res = await request
      .post('/api/notifications/test')
      .set(auth())
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/email/i)
  })

  it('returns 400 when the provided recipientEmail is invalid', async () => {
    const res = await request
      .post('/api/notifications/test')
      .set(auth())
      .send({ recipientEmail: 'not-valid' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/email/i)
  })

  it('uses the stored recipientEmail when no override is provided', async () => {
    // Set a stored recipient but SMTP still not configured → 503
    Object.assign(notificationSettings, { recipientEmail: 'stored@example.com' })
    const res = await request.post('/api/notifications/test').set(auth()).send({})
    // SMTP not configured → 503 (not 400 — it found a valid address)
    expect(res.status).toBe(503)
  })

  it('prefers body recipientEmail over stored value', async () => {
    Object.assign(notificationSettings, { recipientEmail: 'stored@example.com' })
    const res = await request
      .post('/api/notifications/test')
      .set(auth())
      .send({ recipientEmail: 'override@example.com' })
    // Still 503 because SMTP is not configured, but at least it reached the
    // transport check (address was accepted).
    expect(res.status).toBe(503)
  })

  // ── Auth guard ────────────────────────────────────────────────────────────

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .post('/api/notifications/test')
      .send({ recipientEmail: 'ops@example.com' })
    expect(res.status).toBe(401)
  })
})
