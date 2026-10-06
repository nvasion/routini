import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../lib/types'
import { buildTimeline, mergeEvents, placementLabel } from './timeline'

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

describe('placementLabel', () => {
  const at = (data: Record<string, unknown>) => [ev(1, 'log', 0), ev(2, 'step.placement', 0, data)]

  it('names the fleet host and how it was reached', () => {
    expect(placementLabel(at({ target: 'fleet', via: 'runner', host: 'web-1', hostId: 'h' }))).toBe('ran on web-1 · fleet via routini-runner')
    expect(placementLabel(at({ target: 'fleet', via: 'ssh', host: 'db-1', hostId: 'h' }))).toBe('ran on db-1 · fleet via SSH')
  })

  it('distinguishes the agent sandbox, Factory and the Routini worker', () => {
    expect(placementLabel(at({ target: 'sandbox', host: 'routini-agents' }))).toBe('ran in sandbox on routini-agents')
    expect(placementLabel(at({ target: 'sandbox', host: 'routini-agents', environment: 'dev' }))).toBe('ran in sandbox on routini-agents · environment dev')
    expect(placementLabel(at({ target: 'factory', host: 'Factory' }))).toBe('ran on Factory')
    expect(placementLabel(at({ target: 'routini', host: 'Routini worker' }))).toBe('ran on the Routini worker')
  })

  it('uses the latest attempt, and is empty before a step starts', () => {
    const retried = [ev(1, 'step.placement', 0, { target: 'fleet', via: 'ssh', host: 'old' }), ev(2, 'step.placement', 0, { target: 'fleet', via: 'runner', host: 'new' })]
    expect(placementLabel(retried)).toBe('ran on new · fleet via routini-runner')
    expect(placementLabel([ev(1, 'log', 0)])).toBeNull()
    expect(placementLabel(undefined)).toBeNull()
  })
})
