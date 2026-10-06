// Groups a run's events under its steps for the timeline. Pure; see timeline.test.ts.

import type { RunEvent } from '../lib/types'

export interface Timeline {
  /** Events per step index, in order, excluding bare status changes. */
  byStep: Map<number, RunEvent[]>
  /** Artifacts (pull requests, branches) in order. */
  artifacts: RunEvent[]
  lastEventId: number
}

const HIDDEN = new Set(['status', 'step.status', 'cost'])

export function buildTimeline(events: RunEvent[]): Timeline {
  const byStep = new Map<number, RunEvent[]>()
  const artifacts: RunEvent[] = []
  let lastEventId = 0
  const seen = new Set<number>()
  for (const e of events) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    lastEventId = Math.max(lastEventId, e.id)
    if (e.type === 'artifact') artifacts.push(e)
    if (HIDDEN.has(e.type) || e.stepIdx === null) continue
    const list = byStep.get(e.stepIdx) ?? []
    list.push(e)
    byStep.set(e.stepIdx, list)
  }
  return { byStep, artifacts, lastEventId }
}

/** Where a step's latest attempt executed (from its `step.placement` event), as a short label. */
export function placementLabel(stepEvents: RunEvent[] | undefined): string | null {
  let e: RunEvent | undefined
  for (const x of stepEvents ?? []) if (x.type === 'step.placement') e = x
  if (!e) return null
  const d = e.data
  const host = String(d['host'] ?? '')
  switch (d['target']) {
    case 'fleet':
      return `ran on ${host} · fleet via ${d['via'] === 'ssh' ? 'SSH' : 'routini-runner'}`
    case 'sandbox':
      return `ran in sandbox on ${host}${d['environment'] ? ` · environment ${String(d['environment'])}` : ''}`
    case 'factory':
      return 'ran on Factory'
    case 'routini':
      return 'ran on the Routini worker'
    default:
      return host ? `ran on ${host}` : null
  }
}

/** Merges newly streamed events into a list, dropping duplicates and keeping id order. */
export function mergeEvents(prev: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (incoming.length === 0) return prev
  const ids = new Set(prev.map((e) => e.id))
  const fresh = incoming.filter((e) => !ids.has(e.id))
  if (fresh.length === 0) return prev
  return [...prev, ...fresh].sort((a, b) => a.id - b.id)
}
