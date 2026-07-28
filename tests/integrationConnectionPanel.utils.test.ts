import { describe, it, expect } from 'vitest'
import {
  AGENT_SCOPE_OPTIONS,
  TASK_TYPE_OPTIONS,
  buildScopesPayload,
  defaultScopes,
  describeTestResult,
  formatTimestamp,
  toggleValue,
} from '../client/src/components/integrationConnectionPanel.utils'

describe('TASK_TYPE_OPTIONS / AGENT_SCOPE_OPTIONS', () => {
  it('cover every TaskType and AIProvider value the scoping panel needs', () => {
    expect(TASK_TYPE_OPTIONS.map(o => o.value)).toEqual(['daily', 'developmental', 'routine'])
    expect(AGENT_SCOPE_OPTIONS.map(o => o.value)).toEqual(['claude', 'opencode', 'omnimancer'])
  })
})

describe('defaultScopes', () => {
  it('returns every task type and every agent (PRD: "default all")', () => {
    expect(defaultScopes()).toEqual({
      taskTypes: ['daily', 'developmental', 'routine'],
      agents: ['claude', 'opencode', 'omnimancer'],
    })
  })
})

describe('toggleValue', () => {
  it('adds a value that is not present', () => {
    expect(toggleValue(['daily'], 'routine')).toEqual(['daily', 'routine'])
  })

  it('removes a value that is present', () => {
    expect(toggleValue(['daily', 'routine'], 'daily')).toEqual(['routine'])
  })

  it('does not mutate the original array', () => {
    const original = ['daily']
    toggleValue(original, 'routine')
    expect(original).toEqual(['daily'])
  })

  it('supports emptying the list entirely (fully restricted scope)', () => {
    expect(toggleValue(['daily'], 'daily')).toEqual([])
  })
})

describe('buildScopesPayload', () => {
  it('wraps scopes under a `scopes` key for the PUT body', () => {
    const scopes = { taskTypes: ['daily'] as const, agents: ['claude'] as const }
    expect(buildScopesPayload(scopes as never)).toEqual({ scopes })
  })
})

describe('formatTimestamp', () => {
  it('returns "Never" for null', () => {
    expect(formatTimestamp(null)).toBe('Never')
  })

  it('returns "Unknown" for an unparseable timestamp', () => {
    expect(formatTimestamp('not-a-date')).toBe('Unknown')
  })

  it('formats a valid ISO timestamp as a locale string', () => {
    const result = formatTimestamp('2026-07-27T10:00:00.000Z')
    expect(result).not.toBe('Never')
    expect(result).not.toBe('Unknown')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('describeTestResult', () => {
  it('reports "Not tested yet" when never tested', () => {
    expect(describeTestResult(null, null)).toBe('Not tested yet')
  })

  it('reports success with the formatted timestamp', () => {
    expect(describeTestResult(true, '2026-07-27T10:00:00.000Z')).toMatch(/^Connection OK — last tested /)
  })

  it('reports failure with the formatted timestamp', () => {
    expect(describeTestResult(false, '2026-07-27T10:00:00.000Z')).toMatch(/^Connection failed — last tested /)
  })
})
