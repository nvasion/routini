// Cancelling a run, shared by the HTTP API and the MCP server.

import type { AppContext } from '../http/common.js'
import { getRun, requestCancel, TERMINAL_RUN, type Run } from '../repos/runs.js'

export class RunStateError extends Error {}

/**
 * Requests cancellation. A run nobody is executing (waiting, or queued and
 * unclaimed) is finalised here; a running one stops on its worker's next
 * heartbeat. Returns the run as it is now.
 */
export async function cancelRun(ctx: AppContext, orgId: string, run: Run): Promise<Run> {
  const { db } = ctx
  if (TERMINAL_RUN.includes(run.status)) throw new RunStateError(`Run is already ${run.status}`)
  await db.org(orgId, (q) => requestCancel(q, orgId, run.id))
  const idle = await db.org(orgId, async (q) => {
    if (run.status === 'waiting') return true
    const freed = await q.query(`DELETE FROM queue WHERE run_id = $1 AND (locked_until IS NULL OR locked_until < now()) RETURNING id`, [run.id])
    return freed.length > 0
  })
  if (idle) await ctx.engine.cancelIdleRun({ ...run, cancelRequested: true })
  return (await db.org(orgId, (q) => getRun(q, orgId, run.id)))!
}
