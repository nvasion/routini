import { describe, it, expect } from 'vitest'
import { formatLastRun, getConfigEntries } from '../client/src/components/taskConfigPanel.utils'

describe('formatLastRun', () => {
  it('returns "Never" when lastRunAt is undefined', () => {
    expect(formatLastRun(undefined)).toBe('Never')
  })

  it('returns "Never" when lastRunAt is an empty string', () => {
    expect(formatLastRun('')).toBe('Never')
  })

  it('returns "Never" when lastRunAt is only whitespace', () => {
    expect(formatLastRun('   ')).toBe('Never')
  })

  it('formats a valid ISO timestamp as a localized string', () => {
    const iso = '2024-03-15T09:30:00.000Z'
    const result = formatLastRun(iso)
    expect(result).not.toBe('Never')
    expect(result).not.toBe(iso)
    // Should be parseable back to the same instant.
    expect(new Date(result).getTime()).toBe(new Date(iso).getTime())
  })

  it('falls back to the raw string when the value is not a parseable date', () => {
    expect(formatLastRun('not-a-real-date')).toBe('not-a-real-date')
  })
})

describe('getConfigEntries', () => {
  it('returns an empty array when config is undefined', () => {
    expect(getConfigEntries(undefined)).toEqual([])
  })

  it('returns an empty array when config is null', () => {
    expect(getConfigEntries(null)).toEqual([])
  })

  it('returns an empty array when config is an empty object', () => {
    expect(getConfigEntries({})).toEqual([])
  })

  it('returns [key, value] pairs for a populated config object', () => {
    const entries = getConfigEntries({ url: 'https://example.com', method: 'GET' })
    expect(entries).toEqual([
      ['url', 'https://example.com'],
      ['method', 'GET'],
    ])
  })
})
