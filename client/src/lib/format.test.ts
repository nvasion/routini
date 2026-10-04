import { describe, expect, it } from 'vitest'
import { describeTrigger, duration, initials, money, relativeTime, runStatusLabel } from './format'

const NOW = new Date('2026-10-04T12:00:00Z').getTime()

describe('format', () => {
  it('relative times in both directions', () => {
    expect(relativeTime('2026-10-04T11:59:50Z', NOW)).toBe('just now')
    expect(relativeTime('2026-10-04T11:54:00Z', NOW)).toBe('6m ago')
    expect(relativeTime('2026-10-04T14:00:00Z', NOW)).toBe('in 2h')
    expect(relativeTime('2026-10-01T12:00:00Z', NOW)).toBe('3d ago')
    expect(relativeTime(null)).toBe('—')
  })

  it('durations', () => {
    expect(duration('2026-10-04T11:59:15Z', '2026-10-04T12:00:00Z')).toBe('45s')
    expect(duration('2026-10-04T11:53:48Z', '2026-10-04T12:00:00Z')).toBe('6m 12s')
    expect(duration('2026-10-04T09:30:00Z', '2026-10-04T12:00:00Z')).toBe('2h 30m')
    expect(duration('2026-10-04T11:59:00Z', null, NOW)).toBe('1m 00s')
    expect(duration(null, null)).toBe('—')
  })

  it('money', () => {
    expect(money(0)).toBe('$0')
    expect(money(0.0042)).toBe('$0.0042')
    expect(money(0.38)).toBe('$0.38')
    expect(money(12.5)).toBe('$12.50')
  })

  it('labels', () => {
    expect(runStatusLabel('waiting')).toBe('Waiting on you')
    expect(initials('Kellan Vaid')).toBe('KV')
    expect(initials('ada.lovelace@example.com')).toBe('AL')
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe('cron 0 9 * * *')
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'America/Los_Angeles' })).toBe('cron 0 9 * * * (America/Los_Angeles)')
  })
})
