// ─────────────────────────────────────────────────────────────────────────────
// Cron scheduler.
//
// Each tick locks due jobs with FOR UPDATE SKIP LOCKED, creates one run per
// job and advances next_run_at in the same transaction, so a tick fires each
// due job exactly once no matter how many workers run the scheduler. The next
// fire time is computed from *now*, so ticks missed during downtime collapse
// into a single catch-up run instead of a burst.
// ─────────────────────────────────────────────────────────────────────────────

import type { Db } from '../db/index.js'
import { computeNextRunAt, getJob } from '../repos/jobs.js'
import { createRun } from '../repos/runs.js'

export async function schedulerTick(db: Db, now: Date = new Date()): Promise<number> {
  return db.system(async (q) => {
    const due = await q.query<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM jobs
       WHERE enabled AND archived_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= $1
       ORDER BY next_run_at
       FOR UPDATE SKIP LOCKED
       LIMIT 100`,
      [now],
    )
    for (const d of due) {
      const job = await getJob(q, d.org_id, d.id)
      if (!job) continue
      await createRun(q, job, { kind: 'cron', scheduledFor: job.nextRunAt! })
      await q.query('UPDATE jobs SET next_run_at = $2 WHERE id = $1', [job.id, computeNextRunAt(job, now)])
    }
    return due.length
  })
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private ticking: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly db: Db,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return
    const run = () => {
      this.ticking = schedulerTick(this.db).catch((err) => console.error('[scheduler] tick failed:', (err as Error).message))
    }
    run()
    this.timer = setInterval(run, this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.ticking
  }
}
