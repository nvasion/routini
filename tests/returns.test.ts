// Agent returns: validating the agent's JSON output against config.returns
// fields, and resolving choice fields against the org's connected integrations.

import { describe, it, expect, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { availableChoices, promptForReturns, validateReturns } from '../server/src/engine/returns'
import type { ReturnField } from '../server/src/engine/spec'

describe('validateReturns', () => {
  const fields: ReturnField[] = [
    { name: 'summary', type: 'text', required: true },
    { name: 'score', type: 'number', required: false },
    { name: 'approved', type: 'boolean', required: false },
    { name: 'tier', type: 'choice', choices: [{ value: 'a' }, { value: 'b' }], required: false },
  ]

  it('accepts a well-formed object and drops unknown keys', () => {
    const r = validateReturns(fields, { summary: 'done', score: 3, approved: true, tier: 'a', extra: 'nope' })
    expect(r).toEqual({ out: { summary: 'done', score: 3, approved: true, tier: 'a' } })
    expect('out' in r && r.out).not.toHaveProperty('extra')
  })

  it('reports a missing required field', () => {
    expect(validateReturns(fields, { score: 1 })).toEqual({ error: "The agent's output is missing summary" })
  })

  it('allows an optional field to be absent', () => {
    const r = validateReturns(fields, { summary: 'done' })
    expect(r).toEqual({ out: { summary: 'done' } })
  })

  it('reports the wrong type for text, number and boolean', () => {
    expect(validateReturns(fields, { summary: 42 })).toEqual({ error: 'summary must be a text' })
    expect(validateReturns(fields, { summary: 'ok', score: 'nope' })).toEqual({ error: 'score must be a number' })
    expect(validateReturns(fields, { summary: 'ok', approved: 'yes' })).toEqual({ error: 'approved must be a boolean' })
  })

  it('rejects text over the 20000-character limit', () => {
    expect(validateReturns(fields, { summary: 'x'.repeat(20_001) })).toEqual({ error: 'summary must be at most 20000 characters' })
  })

  it('reports a bad choice, naming the valid ones', () => {
    expect(validateReturns(fields, { summary: 'ok', tier: 'z' })).toEqual({ error: "tier must be one of: a, b (got 'z')" })
    expect(validateReturns(fields, { summary: 'ok', tier: 3 })).toEqual({ error: "tier must be one of: a, b (got '3')" })
  })

  it('fails on a non-object payload', () => {
    expect(validateReturns(fields, 'not json')).toEqual({ error: 'The agent did not write a JSON object to $ROUTINI_OUT_FILE' })
    expect(validateReturns(fields, null)).toEqual({ error: 'The agent did not write a JSON object to $ROUTINI_OUT_FILE' })
    expect(validateReturns(fields, ['a'])).toEqual({ error: 'The agent did not write a JSON object to $ROUTINI_OUT_FILE' })
  })

  it('treats explicit null the same as a missing field', () => {
    expect(validateReturns(fields, { summary: 'ok', approved: null })).toEqual({ out: { summary: 'ok' } })
  })
})

describe('availableChoices and promptForReturns (requires-filtering)', () => {
  let t: TestApp
  let u: TestUser
  const base = () => `/api/orgs/${u.orgSlug}`

  afterEach(async () => {
    await t.close()
  })

  it('drops a choice whose integration is not connected, and includes it once it is', async () => {
    t = await makeTestApp({})
    u = await t.signup('returns@example.com')
    const field: ReturnField = { name: 'action', type: 'choice', choices: [{ value: 'ship' }, { value: 'escalate', requires: 'github' }] }

    const before = await t.ctx.db.org(u.orgId, (q) => availableChoices(q, u.orgId, field))
    expect(before).toEqual([{ value: 'ship' }])

    await u.put(`${base()}/integrations/github`, { credentials: { token: 'ghp_x0123456789abcdefghij' } })
    const after = await t.ctx.db.org(u.orgId, (q) => availableChoices(q, u.orgId, field))
    expect(after).toEqual([{ value: 'ship' }, { value: 'escalate', requires: 'github' }])
  })

  it('fails before the step starts when a choice field has nothing left to offer', async () => {
    t = await makeTestApp({})
    u = await t.signup('returns2@example.com')
    const fields: ReturnField[] = [{ name: 'action', type: 'choice', choices: [{ value: 'escalate', requires: 'github' }, { value: 'notify', requires: 'slack' }] }]
    const result = await t.ctx.db.org(u.orgId, (q) => promptForReturns(q, u.orgId, fields))
    expect(result).toEqual({ error: 'Field action has no available choices (needs: github, slack)' })
  })

  it('builds the system-prompt sentence, naming type, choices and description', async () => {
    t = await makeTestApp({})
    u = await t.signup('returns3@example.com')
    const fields: ReturnField[] = [
      { name: 'summary', type: 'text', description: 'What changed' },
      { name: 'tier', type: 'choice', choices: [{ value: 'a' }, { value: 'b', requires: 'github' }], description: 'Severity' },
    ]
    const result = await t.ctx.db.org(u.orgId, (q) => promptForReturns(q, u.orgId, fields))
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.prompt).toBe(
      'Before you finish, write one JSON object to $ROUTINI_OUT_FILE with these fields: ' +
        'summary (text) - What changed; tier (choice, one of: a) - Severity.',
    )
    expect(result.fields[1]!.choices).toEqual([{ value: 'a' }])
  })
})
