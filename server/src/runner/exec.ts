// ─────────────────────────────────────────────────────────────────────────────
// Worker side of runner tasks: queue a task for a runner, stream its output
// back, and wait for the result. Works across processes: the runner gateway may
// live in any API instance; everything goes through runner_tasks and NOTIFY.
//
// runTaskOnRunner() is the loop both kinds of task share (exec here, agents in
// agent.ts): queue, wait out an offline runner, stream output, cancel on abort.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import { createRunnerTask, finishRunnerTask, getRunnerTask, requestTaskCancel, RUNNER_OUT_CHANNEL, type ExecResultData, type RunnerTask } from '../repos/runners.js'
import type { StepContext } from '../engine/types.js'

export const STDOUT_TAIL_BYTES = 16 * 1024

/** The runner kills a task within ~5 s of a cancel; don't wait forever for its answer. */
const CANCEL_GRACE_MS = 15_000

const canceledResult = (): ExecResultData => ({ exitCode: null, timedOut: false, canceled: true, error: null })

export interface RunnerTaskOptions {
  runnerId: string
  hostName: string
  /** Queues the task inside the org context. The loop then waits for its result. */
  create: (q: Queryable, orgId: string) => Promise<RunnerTask>
  /** Called for each output line, in order. */
  onLine: (line: string, stream: 'stdout' | 'stderr') => void | Promise<void>
  /** How long a queued task waits for an offline runner to reconnect. */
  offlineGraceMs?: number
  pollMs?: number
}

/** How a task's wait ended: with a result (possibly none), or with the row gone. */
export type RunnerTaskOutcome = { kind: 'finished'; result: ExecResultData | null } | { kind: 'gone' }

/**
 * Queues a runner task and waits for it, streaming its output lines to
 * `onLine`. Gives up with an `offline` result when the runner never picks the
 * task up, and asks the runner to cancel when ctx.signal aborts.
 */
export async function runTaskOnRunner(ctx: StepContext, o: RunnerTaskOptions): Promise<RunnerTaskOutcome> {
  const { db } = ctx.app
  const orgId = ctx.org.id
  const grace = o.offlineGraceMs ?? 30_000
  const pollMs = o.pollMs ?? 2_000

  let taskId: string | null = null
  // Output lines are handed to onLine one at a time, in arrival order.
  let lineChain: Promise<void> = Promise.resolve()
  let wake: (() => void) | null = null
  // NOTIFY can beat the INSERT's return; output for an unknown task id is held.
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
      const stream = l.s === 'stderr' ? 'stderr' : 'stdout'
      lineChain = lineChain.then(() => o.onLine(l.d, stream)).then(
        () => {},
        () => {},
      )
    }
    if (msg.done) wake?.()
  }

  const unlisten = await db.listen(RUNNER_OUT_CHANNEL, onOut)
  try {
    const task = await db.org(orgId, (q) => o.create(q, orgId))
    taskId = task.id
    for (const p of early.splice(0)) handle(p)

    const started = Date.now()
    let cancelSent = false
    let cancelAt = 0
    for (;;) {
      const t = await db.org(orgId, (q) => getRunnerTask(q, orgId, task.id))
      if (!t) return { kind: 'gone' }
      if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') {
        await lineChain
        return { kind: 'finished', result: t.result }
      }
      // Still queued: the runner is offline (or reconnecting).
      if (t.status === 'queued' && Date.now() - started > grace) {
        const offline: ExecResultData = { exitCode: null, timedOut: false, canceled: false, error: 'offline' }
        const gaveUp = await db.org(orgId, (q) => finishRunnerTask(q, orgId, task.id, 'failed', offline))
        if (gaveUp) {
          await lineChain
          return { kind: 'finished', result: offline }
        }
        continue
      }
      if (ctx.signal.aborted && !cancelSent) {
        cancelSent = true
        cancelAt = Date.now()
        await db.org(orgId, (q) => requestTaskCancel(q, orgId, task.id, o.runnerId))
        if (t.status === 'queued') {
          await db.org(orgId, (q) => finishRunnerTask(q, orgId, task.id, 'canceled', canceledResult()))
        }
      }
      if (cancelSent && Date.now() - cancelAt > CANCEL_GRACE_MS) {
        await db.org(orgId, (q) => finishRunnerTask(q, orgId, task.id, 'canceled', canceledResult()))
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

// ── Commands ──────────────────────────────────────────────────────────────────

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

/** Runs a shell command on a runner host, streaming output into the timeline. */
export async function execOnRunner(ctx: StepContext, o: RunnerExecOptions): Promise<RunnerExecOutcome> {
  let stdout = ''
  const ended = await runTaskOnRunner(ctx, {
    runnerId: o.runnerId,
    hostName: o.hostName,
    offlineGraceMs: o.offlineGraceMs,
    pollMs: o.pollMs,
    create: (q, orgId) =>
      createRunnerTask(q, orgId, o.runnerId, { type: 'exec', command: o.command, env: o.env, cwd: null, timeoutSec: o.timeoutSec }, { runId: ctx.run.id, stepIdx: ctx.idx }),
    onLine: (line, stream) => {
      if (stream === 'stdout') stdout = (stdout + line + '\n').slice(-STDOUT_TAIL_BYTES)
      // Through ctx.emit, so redaction applies.
      return ctx.emit('log', stream === 'stderr' ? { message: line, stream: 'stderr' } : { message: line })
    },
  })
  if (ended.kind === 'gone') return { ok: false, exitCode: null, stdout, error: 'The runner task disappeared' }
  return outcome(ended.result, o.hostName, stdout)
}

function outcome(result: ExecResultData | null, hostName: string, stdout: string): RunnerExecOutcome {
  if (!result) return { ok: false, exitCode: null, stdout, error: 'The runner returned no result' }
  if (result.canceled) return { ok: false, exitCode: result.exitCode, stdout, error: 'Canceled' }
  if (result.timedOut) return { ok: false, exitCode: result.exitCode, stdout, error: `The command timed out on "${hostName}"` }
  if (result.error) return { ok: false, exitCode: result.exitCode, stdout, error: result.error === 'offline' ? `The runner on "${hostName}" is offline` : `Runner: ${result.error}` }
  if (result.exitCode !== 0) return { ok: false, exitCode: result.exitCode, stdout, error: `Command exited with code ${result.exitCode ?? 'unknown (killed)'}` }
  return { ok: true, exitCode: 0, stdout }
}
