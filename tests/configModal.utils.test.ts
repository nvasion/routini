import { describe, it, expect } from 'vitest'
import {
  configRowsToRecord,
  validateDailyForm,
  buildDailyUpdatePayload,
  validateDevForm,
  buildDevUpdatePayload,
  validateMetaForm,
  buildMetaUpdatePayload,
  DAILY_ACTION_TYPES,
  AGENT_OPTIONS,
} from '../client/src/components/configModal.utils'

describe('configRowsToRecord', () => {
  it('returns an empty object for an empty row list', () => {
    expect(configRowsToRecord([])).toEqual({})
  })

  it('skips rows with a blank key', () => {
    expect(configRowsToRecord([{ key: '', value: 'x' }, { key: '   ', value: 'y' }])).toEqual({})
  })

  it('trims keys and values', () => {
    expect(configRowsToRecord([{ key: '  url  ', value: '  https://example.com  ' }])).toEqual({
      url: 'https://example.com',
    })
  })

  it('lets a later duplicate key overwrite an earlier one', () => {
    expect(
      configRowsToRecord([
        { key: 'method', value: 'GET' },
        { key: 'method', value: 'POST' },
      ]),
    ).toEqual({ method: 'POST' })
  })
})

describe('validateDailyForm', () => {
  const base = {
    name: 'Health check',
    description: '',
    schedule: '0 9 * * *',
    actionType: 'http' as const,
    configRows: [],
  }

  it('accepts a fully valid form', () => {
    expect(validateDailyForm(base)).toBeNull()
  })

  it('rejects a blank name', () => {
    expect(validateDailyForm({ ...base, name: '   ' })).toMatch(/name/i)
  })

  it('rejects a blank schedule', () => {
    expect(validateDailyForm({ ...base, schedule: '' })).toMatch(/schedule/i)
  })

  it('rejects an actionType outside the known set', () => {
    // @ts-expect-error intentionally invalid for the test
    expect(validateDailyForm({ ...base, actionType: 'carrier-pigeon' })).toMatch(/action type/i)
  })

  it('exposes the three supported action types', () => {
    expect(DAILY_ACTION_TYPES).toEqual(['ssh', 'email', 'http'])
  })
})

describe('buildDailyUpdatePayload', () => {
  const base = {
    name: '  Health check  ',
    description: '  Checks health  ',
    schedule: '  0 9 * * *  ',
    actionType: 'http' as const,
    configRows: [],
  }

  it('trims name/description/schedule and omits config when no rows were filled in', () => {
    const payload = buildDailyUpdatePayload(base)
    expect(payload).toEqual({
      name: 'Health check',
      description: 'Checks health',
      schedule: '0 9 * * *',
      actionType: 'http',
    })
    expect(payload).not.toHaveProperty('config')
  })

  it('includes config when at least one row has a key', () => {
    const payload = buildDailyUpdatePayload({
      ...base,
      configRows: [{ key: 'url', value: 'https://example.com' }],
    })
    expect(payload).toMatchObject({ config: { url: 'https://example.com' } })
  })
})

describe('validateDevForm', () => {
  const base = {
    name: 'Refactor auth',
    description: '',
    repoUrl: 'https://github.com/example/repo',
    branch: 'main',
    agentId: 'claude',
  }

  it('accepts a fully valid form', () => {
    expect(validateDevForm(base)).toBeNull()
  })

  it('rejects a blank name', () => {
    expect(validateDevForm({ ...base, name: '' })).toMatch(/name/i)
  })

  it('rejects a blank repoUrl', () => {
    expect(validateDevForm({ ...base, repoUrl: '  ' })).toMatch(/repository/i)
  })

  it('rejects a blank branch', () => {
    expect(validateDevForm({ ...base, branch: '' })).toMatch(/branch/i)
  })

  it('rejects a blank agentId', () => {
    expect(validateDevForm({ ...base, agentId: '' })).toMatch(/agent/i)
  })

  it('exposes at least one known agent option', () => {
    expect(AGENT_OPTIONS.length).toBeGreaterThan(0)
    expect(AGENT_OPTIONS.map(o => o.value)).toContain('claude')
  })
})

describe('buildDevUpdatePayload', () => {
  it('trims every field', () => {
    const payload = buildDevUpdatePayload({
      name: '  Refactor auth  ',
      description: '  desc  ',
      repoUrl: '  https://github.com/example/repo  ',
      branch: '  main  ',
      agentId: '  claude  ',
    })
    expect(payload).toEqual({
      name: 'Refactor auth',
      description: 'desc',
      repoUrl: 'https://github.com/example/repo',
      branch: 'main',
      agentId: 'claude',
    })
  })
})

describe('validateMetaForm / buildMetaUpdatePayload', () => {
  it('rejects a blank name', () => {
    expect(validateMetaForm({ name: '  ', description: '' })).toMatch(/name/i)
  })

  it('accepts a valid name', () => {
    expect(validateMetaForm({ name: 'Morning Workflow', description: '' })).toBeNull()
  })

  it('trims name and description', () => {
    expect(buildMetaUpdatePayload({ name: '  Morning Workflow  ', description: '  desc  ' })).toEqual({
      name: 'Morning Workflow',
      description: 'desc',
    })
  })
})
