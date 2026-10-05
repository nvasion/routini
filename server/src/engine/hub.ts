// ─────────────────────────────────────────────────────────────────────────────
// In-process fan-out of run event notifications.
//
// One LISTEN per process on `routini_events`; SSE handlers subscribe by run or
// by org and fetch the actual events from Postgres (notifications only carry
// ids), so a missed notification can never lose an event.
// ─────────────────────────────────────────────────────────────────────────────

import type { Db } from '../db/index.js'
import { EVENTS_CHANNEL, type EventNotice } from '../repos/runs.js'

type Listener = (n: EventNotice) => void

export class EventHub {
  private readonly byRun = new Map<string, Set<Listener>>()
  private readonly byOrg = new Map<string, Set<Listener>>()
  private started: Promise<void> | null = null
  private unlisten: (() => Promise<void>) | null = null

  constructor(private readonly db: Db) {}

  start(): Promise<void> {
    this.started ??= this.db
      .listen(EVENTS_CHANNEL, (payload) => {
        let n: EventNotice
        try {
          n = JSON.parse(payload) as EventNotice
        } catch {
          return
        }
        for (const l of this.byRun.get(n.r) ?? []) l(n)
        for (const l of this.byOrg.get(n.o) ?? []) l(n)
      })
      .then((stop) => {
        this.unlisten = stop
      })
    return this.started
  }

  async stop(): Promise<void> {
    await this.started
    await this.unlisten?.()
  }

  async subscribeRun(runId: string, l: Listener): Promise<() => void> {
    await this.start()
    return add(this.byRun, runId, l)
  }

  async subscribeOrg(orgId: string, l: Listener): Promise<() => void> {
    await this.start()
    return add(this.byOrg, orgId, l)
  }
}

function add(map: Map<string, Set<Listener>>, key: string, l: Listener): () => void {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(l)
  return () => {
    set!.delete(l)
    if (set!.size === 0) map.delete(key)
  }
}
