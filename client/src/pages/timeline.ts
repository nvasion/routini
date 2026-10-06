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

/** Merges newly streamed events into a list, dropping duplicates and keeping id order. */
export function mergeEvents(prev: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (incoming.length === 0) return prev
  const ids = new Set(prev.map((e) => e.id))
  const fresh = incoming.filter((e) => !ids.has(e.id))
  if (fresh.length === 0) return prev
  return [...prev, ...fresh].sort((a, b) => a.id - b.id)
}
