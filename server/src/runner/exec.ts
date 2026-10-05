// ─────────────────────────────────────────────────────────────────────────────
// Worker side of runner commands: queue an exec for a runner, stream its output
// into the step's timeline (through ctx.emit, so redaction applies), and wait
// for the result. Works across processes: the runner gateway may live in any
// API instance; everything goes through runner_tasks and NOTIFY.
// ─────────────────────────────────────────────────────────────────────────────

import { createRunnerTask, finishRunnerTask, getRunnerTask, requestTaskCancel, RUNNER_OUT_CHANNEL, type ExecResultData } from '../repos/runners.js'
import type { StepContext } from '../engine/types.js'

export const STDOUT_TAIL_BYTES = 16 * 1024

export interface RunnerExecOptions {
  runnerId: string
  hostName: string
  command: string
  timeoutSec: number
  env?: Record<string, string>
  /** How long a queued command waits for an offline runner to reconnect. */
  offlineGraceMs?: number
  pollMs?: number
}

export interface RunnerExecOutcome {
  ok: boolean
  exitCode: number | null
  stdout: string
  error?: string
}

export async function execOnRunner(ctx: StepContext, o: RunnerExecOptions): Promise<RunnerExecOutcome> {
  const { db } = ctx.app
  const orgId = ctx.org.id
  const grace = o.offlineGraceMs ?? 30_000
  const pollMs = o.pollMs ?? 2_000

  let taskId: string | null = null
  let stdout = ''
  let logChain: Promise<void> = Promise.resolve()
  let wake: (() => void) | null = null
  const early: string[] = []

  const onOut = (payload: string) => {
    if (!taskId) return void early.push(payload)
    handle(payload)
  }
  const handle = (payload: string) => {
    let msg: { taskId?: string; lines?: Array<{ s: string; d: string }>; done?: boolean }
    try {
      msg = JSON.parse(payload) as typeof msg
    } catch {
      return
    }
    if (msg.taskId !== taskId) return
    for (const l of msg.lines ?? []) {
      if (l.s === 'stdout') stdout = (stdout + l.d + '\n').slice(-STDOUT_TAIL_BYTES)
      logChain = logChain.then(() => ctx.emit('log', l.s === 'stderr' ? { message: l.d, stream: 'stderr' } : { message: l.d })).catch(() => {})
    }
    if (msg.done) wake?.()
  }

  const unlisten = await db.listen(RUNNER_OUT_CHANNEL, onOut)
  try {
    const task = await db.org(orgId, (q) =>
      createRunnerTask(q, orgId, o.runnerId, { type: 'exec', command: o.command, env: o.env, cwd: null, timeoutSec: o.timeoutSec }, { runId: ctx.run.id, stepIdx: ctx.idx }),
    )
    taskId = task.id
    for (const p of early.splice(0)) handle(p)

    const started = Date.now()
    let cancelSent = false
    let cancelAt = 0
    for (;;) {
      const t = await db.org(orgId, (q) => getRunnerTask(q, orgId, task.id))
      if (!t) return { ok: false, exitCode: null, stdout, error: 'The runner task disappeared' }
      if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') {
        await logChain
        return outcome(t.result, o.hostName, stdout)
      }
      // Still queued: the runner is offline (or reconnecting).
      if (t.status === 'queued' && Date.now() - started > grace) {
        const gaveUp = await db.org(orgId, (q) =>
          finishRunnerTask(q, orgId, task.id, 'failed', { exitCode: null, timedOut: false, canceled: false, error: 'offline' }),
        )
        if (gaveUp) return { ok: false, exitCode: null, stdout, error: `The runner on "${o.hostName}" is offline` }
        continue
      }
      if (ctx.signal.aborted && !cancelSent) {
        cancelSent = true
        cancelAt = Date.now()
        await db.org(orgId, (q) => requestTaskCancel(q, orgId, task.id, o.runnerId))
        if (t.status === 'queued') {
          await db.org(orgId, (q) => finishRunnerTask(q, orgId, task.id, 'canceled', { exitCode: null, timedOut: false, canceled: true, error: null }))
        }
      }
      // The runner kills the process within ~5 s of a cancel; don't wait forever for its answer.
      if (cancelSent && Date.now() - cancelAt > 15_000) {
        await db.org(orgId, (q) => finishRunnerTask(q, orgId, task.id, 'canceled', { exitCode: null, timedOut: false, canceled: true, error: null }))
        continue
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          ctx.signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, pollMs)
        wake = done
        ctx.signal.addEventListener('abort', done, { once: true })
      })
      wake = null
    }
  } finally {
    await unlisten()
  }
}

function outcome(result: ExecResultData | null, hostName: string, stdout: string): RunnerExecOutcome {
  if (!result) return { ok: false, exitCode: null, stdout, error: 'The runner returned no result' }
  if (result.canceled) return { ok: false, exitCode: result.exitCode, stdout, error: 'Canceled' }
  if (result.timedOut) return { ok: false, exitCode: result.exitCode, stdout, error: `The command timed out on "${hostName}"` }
  if (result.error) return { ok: false, exitCode: result.exitCode, stdout, error: result.error === 'offline' ? `The runner on "${hostName}" is offline` : `Runner: ${result.error}` }
  if (result.exitCode !== 0) return { ok: false, exitCode: result.exitCode, stdout, error: `Command exited with code ${result.exitCode ?? 'unknown (killed)'}` }
  return { ok: true, exitCode: 0, stdout }
}
