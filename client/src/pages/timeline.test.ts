import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../lib/types'
import { buildTimeline, mergeEvents } from './timeline'

const ev = (id: number, type: string, stepIdx: number | null, data: Record<string, unknown> = {}): RunEvent => ({ id, runId: 'r', stepIdx, ts: '', type, data })

describe('timeline', () => {
  it('groups events under steps and hides bare status changes', () => {
    const t = buildTimeline([
      ev(1, 'status', null, { status: 'queued' }),
      ev(2, 'step.status', 0, { status: 'running' }),
      ev(3, 'log', 0, { message: 'GET https://x' }),
      ev(4, 'agent.tool_call', 1, { name: 'Bash' }),
      ev(5, 'artifact', 1, { kind: 'pull_request', url: 'u' }),
      ev(6, 'cost', 1, { usd: 0.1 }),
    ])
    expect([...t.byStep.keys()]).toEqual([0, 1])
    expect(t.byStep.get(0)!.map((e) => e.id)).toEqual([3])
    expect(t.byStep.get(1)!.map((e) => e.type)).toEqual(['agent.tool_call', 'artifact'])
    expect(t.artifacts.map((a) => a.id)).toEqual([5])
    expect(t.lastEventId).toBe(6)
  })

  it('ignores duplicate deliveries', () => {
    const t = buildTimeline([ev(3, 'log', 0), ev(3, 'log', 0)])
    expect(t.byStep.get(0)).toHaveLength(1)
  })

  it('merges streamed events in id order without duplicates', () => {
    const a = [ev(1, 'log', 0), ev(3, 'log', 0)]
    const merged = mergeEvents(a, [ev(2, 'log', 0), ev(3, 'log', 0)])
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3])
    expect(mergeEvents(a, [ev(1, 'log', 0)])).toBe(a)
  })
})
