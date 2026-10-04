// ─────────────────────────────────────────────────────────────────────────────
// Queue worker.
//
// Claims queue items with FOR UPDATE SKIP LOCKED under a lease, so any number
// of workers (processes) can share one database. Per-org concurrency is
// enforced at claim time under a per-org advisory lock. While a run executes,
// a heartbeat renews the lease and watches for cancel; if the lease is lost
// (e.g. this process stalled past it), execution is aborted.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { AppContext } from '../http/common.js'
import { effectiveLimits } from '../repos/identity.js'
import { QUEUE_CHANNEL, setRunStatus } from '../repos/runs.js'
import type { Engine } from './engine.js'

export interface WorkerOptions {
  id?: string
  concurrency?: number
  pollMs?: number
  leaseMs?: number
  heartbeatMs?: number
  /** A queue item claimed this many times without finishing fails its run. */
  maxClaims?: number
}

interface Claim {
  queueId: number
  runId: string
  orgId: string
}

export class Worker {
  readonly id: string
  private readonly concurrency: number
  private readonly pollMs: number
  private readonly leaseMs: number
  private readonly heartbeatMs: number
  private readonly maxClaims: number
  private readonly active = new Map<string, Promise<void>>()
  private running = false
  private wake: (() => void) | null = null
  private loopDone: Promise<void> | null = null
  private unlisten: (() => Promise<void>) | null = null

  constructor(
    private readonly app: AppContext,
    private readonly engine: Engine,
    opts: WorkerOptions = {},
  ) {
    this.id = opts.id ?? `worker-${randomUUID().slice(0, 8)}`
    this.concurrency = opts.concurrency ?? 4
    this.pollMs = opts.pollMs ?? 1000
    this.leaseMs = opts.leaseMs ?? 60_000
    this.heartbeatMs = opts.heartbeatMs ?? 2_000
    this.maxClaims = opts.maxClaims ?? 5
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.unlisten = await this.app.db.listen(QUEUE_CHANNEL, () => this.wake?.())
    this.loopDone = this.loop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.wake?.()
    await this.loopDone
    await Promise.allSettled(this.active.values())
    await this.unlisten?.()
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick()
      } catch (err) {
        console.error(`[worker ${this.id}] tick failed:`, (err as Error).message)
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.pollMs)
        this.wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      this.wake = null
    }
  }

  /** Claims and starts as much work as there are free slots. Returns how many runs started. */
  async tick(): Promise<number> {
    const free = this.concurrency - this.active.size
    if (free <= 0) return 0
    const claims = await this.claim(free)
    for (const c of claims) {
      const p = this.execute(c).finally(() => this.active.delete(c.runId))
      this.active.set(c.runId, p)
    }
    return claims.length
  }

  /** Test helper: runs ticks until no work is claimable and nothing is active. */
  async drain(maxTicks = 200): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      const started = await this.tick()
      if (started === 0 && this.active.size === 0) return
      await Promise.race([...this.active.values(), new Promise((r) => setTimeout(r, 5))])
    }
    throw new Error('Worker.drain() did not settle')
  }

  private async claim(max: number): Promise<Claim[]> {
    return this.app.db.system(async (q) => {
      const candidates = await q.query<{ id: string | number; run_id: string; org_id: string; attempts: number }>(
        `SELECT id, run_id, org_id, attempts FROM queue
         WHERE available_at <= now() AND (locked_until IS NULL OR locked_until < now())
         ORDER BY available_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [max * 4],
      )
      const claimed: Claim[] = []
      for (const c of candidates) {
        if (claimed.length >= max) break
        if (this.active.has(c.run_id)) continue

        if (c.attempts >= this.maxClaims) {
          await setRunStatus(q, { id: c.run_id, orgId: c.org_id }, 'failed', { error: 'The engine could not complete this run after repeated attempts' })
          await q.query('DELETE FROM queue WHERE id = $1', [c.id])
          continue
        }

        // Serialise concurrency decisions per org across all workers.
        await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [c.org_id])
        const [org] = await q.query<{ plan: string; limits: Record<string, number | null> }>('SELECT plan, limits FROM orgs WHERE id = $1', [c.org_id])
        const limit = effectiveLimits(org?.plan ?? 'free', org?.limits).maxConcurrentRuns
        const [busy] = await q.query<{ n: string | number }>(
          `SELECT count(*) AS n FROM runs WHERE org_id = $1 AND status = 'running' AND id <> $2`,
          [c.org_id, c.run_id],
        )
        if (Number(busy?.n ?? 0) >= limit) continue

        await q.query(
          `UPDATE queue SET locked_by = $2, locked_until = now() + make_interval(secs => $3), attempts = attempts + 1 WHERE id = $1`,
          [c.id, this.id, this.leaseMs / 1000],
        )
        // Mark running now so the next claim in this org counts it.
        const [cur] = await q.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [c.run_id])
        if (cur?.status === 'queued') await setRunStatus(q, { id: c.run_id, orgId: c.org_id }, 'running')
        claimed.push({ queueId: Number(c.id), runId: c.run_id, orgId: c.org_id })
      }
      return claimed
    })
  }

  private async execute(c: Claim): Promise<void> {
    const controller = new AbortController()
    const heartbeat = setInterval(() => {
      void this.app.db
        .system((q) =>
          q.query<{ cancel: boolean }>(
            `UPDATE queue SET locked_until = now() + make_interval(secs => $3)
             FROM runs WHERE queue.run_id = runs.id AND queue.id = $1 AND queue.locked_by = $2
             RETURNING runs.cancel_requested AS cancel`,
            [c.queueId, this.id, this.leaseMs / 1000],
          ),
        )
        .then((rows) => {
          if (rows.length === 0) controller.abort(new Error('lease lost'))
          else if (rows[0]!.cancel) controller.abort(new Error('canceled'))
        })
        .catch((err) => console.error(`[worker ${this.id}] heartbeat failed:`, (err as Error).message))
    }, this.heartbeatMs)

    try {
      await this.engine.advance(c.runId, controller.signal)
    } catch (err) {
      // Leave the item for a later claim (attempts are counted; see maxClaims).
      console.error(`[worker ${this.id}] run ${c.runId} errored:`, (err as Error).message)
      await this.app.db
        .system((q) => q.query(`UPDATE queue SET locked_by = NULL, locked_until = NULL, available_at = now() + interval '5 seconds' WHERE id = $1`, [c.queueId]))
        .catch(() => {})
    } finally {
      clearInterval(heartbeat)
      // Release the lease if the item still exists and is ours (finished/waiting runs deleted it).
      await this.app.db
        .system((q) => q.query(`UPDATE queue SET locked_by = NULL, locked_until = NULL WHERE id = $1 AND locked_by = $2`, [c.queueId, this.id]))
        .catch(() => {})
    }
  }
}
