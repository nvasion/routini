// ─────────────────────────────────────────────────────────────────────────────
// Worker side of agent tasks: run a coding agent in a container on a fleet
// host. Shares runTaskOnRunner()'s queue/wait/stream/cancel loop with command
// steps; only the task row and the result shape differ.
//
// The container env and the egress session (which carries real credentials)
// are sealed into the task row, so nothing but the gateway holding the runner's
// connection can read them — see createAgentRunnerTask.
// ─────────────────────────────────────────────────────────────────────────────

import { createAgentRunnerTask, type AgentPayload, type AgentSecret, type ExecResultData } from '../repos/runners.js'
import type { StepContext } from '../engine/types.js'
import { runTaskOnRunner } from './exec.js'

export interface RunnerAgentOptions {
  runnerId: string
  hostName: string
  /** Everything about the container that is not secret. */
  payload: Omit<AgentPayload, 'sealed'>
  /** Sealed into the task row: container env and the egress session. */
  secret: AgentSecret
  /** Called for each output line of the agent container, in order. */
  onLine: (line: string, stream: 'stdout' | 'stderr') => void
  /** How long a queued agent waits for an offline runner to reconnect. */
  offlineGraceMs?: number
  pollMs?: number
}

export interface RunnerAgentOutcome {
  ok: boolean
  exitCode: number | null
  error?: string
  /** What the host's egress proxy saw, when the runner reported it. */
  egress: NonNullable<ExecResultData['egress']> | null
}

/** Runs an agent container on a runner host and waits for it to exit. */
export async function runAgentOnRunner(ctx: StepContext, o: RunnerAgentOptions): Promise<RunnerAgentOutcome> {
  const ended = await runTaskOnRunner(ctx, {
    runnerId: o.runnerId,
    hostName: o.hostName,
    offlineGraceMs: o.offlineGraceMs,
    pollMs: o.pollMs,
    create: (q, orgId) => createAgentRunnerTask(q, ctx.app.box, orgId, o.runnerId, o.payload, o.secret, { runId: ctx.run.id, stepIdx: ctx.idx }),
    onLine: o.onLine,
  })
  if (ended.kind === 'gone') return { ok: false, exitCode: null, error: 'The runner task disappeared', egress: null }
  return outcome(ended.result, o.hostName)
}

function outcome(result: ExecResultData | null, hostName: string): RunnerAgentOutcome {
  if (!result) return { ok: false, exitCode: null, error: 'The runner returned no result', egress: null }
  const egress = result.egress ?? null
  if (result.canceled) return { ok: false, exitCode: result.exitCode, error: 'Canceled', egress }
  if (result.timedOut) return { ok: false, exitCode: result.exitCode, error: `The agent timed out on "${hostName}"`, egress }
  // Anything else the gateway or runner reported is already a sentence for the user.
  if (result.error) return { ok: false, exitCode: result.exitCode, error: result.error === 'offline' ? `The runner on "${hostName}" is offline` : result.error, egress }
  if (result.exitCode !== 0) return { ok: false, exitCode: result.exitCode, error: `The agent exited with code ${result.exitCode ?? 'unknown (killed)'}`, egress }
  return { ok: true, exitCode: 0, egress }
}
