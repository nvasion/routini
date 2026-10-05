// ─────────────────────────────────────────────────────────────────────────────
// The run state machine.
//
// advance(runId) moves one run forward until it finishes, parks (approval), or
// schedules a retry. It is safe to call repeatedly and after crashes:
//   – every transition is persisted before the next one starts;
//   – a step left 'running' by a dead worker is failed as "worker lost" (and
//     retried if it has retries left);
//   – executors run outside any transaction, so slow steps hold no locks.
// The caller (worker) owns the queue lease and passes an AbortSignal that
// fires on cancel or lease loss.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppContext } from '../http/common.js'
import { getOrgById } from '../repos/identity.js'
import { getSecret } from '../repos/credentials.js'
import {
  addRunUsage,
  createApproval,
  appendEvent,
  decideApproval,
  dequeueRun,
  enqueueRun,
  getApproval,
  getRunSystem,
  isCancelRequested,
  listSteps,
  setRunStatus,
  TERMINAL_RUN,
  updateStep,
  type Run,
  type RunStep,
} from '../repos/runs.js'
import { redact, redactDeep } from '../utils/redact.js'
import { actionExecutor, approvalExecutor, unavailableAgentExecutor } from './executors.js'
import type { Step } from './spec.js'
import { evaluatePolicy, stepFacts, type Decision } from './policy.js'
import { getPolicy } from '../repos/policy.js'
import type { EngineOptions, StepContext, StepExecutor, StepResult } from './types.js'

export type AdvanceOutcome = 'finished' | 'waiting' | 'retry' | 'canceled' | 'missing'

export interface Engine {
  advance(runId: string, signal?: AbortSignal): Promise<AdvanceOutcome>
  /** Finalises a run that no worker holds (queued or waiting) as canceled. */
  cancelIdleRun(run: Run): Promise<void>
}

const MAX_ERROR_LEN = 2000

export function createEngine(app: AppContext, opts: EngineOptions = {}): Engine {
  const executors: Record<Step['kind'], StepExecutor> = {
    action: opts.executors?.action ?? actionExecutor(opts.actions),
    approval: opts.executors?.approval ?? approvalExecutor,
    agent: opts.executors?.agent ?? unavailableAgentExecutor,
  }
  const retryDelay = opts.retryDelayMs ?? ((attempt: number) => 5000 * attempt)
  const db = app.db

  async function finishRun(run: Run, status: 'succeeded' | 'failed' | 'canceled', error?: string): Promise<void> {
    await db.org(run.orgId, async (q) => {
      if (status === 'canceled') {
        // Close out anything still open.
        const steps = await listSteps(q, run.orgId, run.id)
        for (const s of steps) {
          if (s.status === 'pending' || s.status === 'running' || s.status === 'waiting') {
            await updateStep(q, run, s.idx, { status: 'canceled' })
          }
          if (s.status === 'waiting') {
            const a = await getApproval(q, run.orgId, run.id, s.idx)
            if (a?.status === 'pending') await decideApproval(q, run.orgId, a.id, 'canceled', null, null)
          }
        }
      }
      await setRunStatus(q, run, status, error ? { error: error.slice(0, MAX_ERROR_LEN) } : {})
      await dequeueRun(q, run.id)
    })
    if (opts.onRunFinished) {
      const final = await db.system((q) => getRunSystem(q, run.id))
      if (final) await opts.onRunFinished(final).catch((err) => console.error('[engine] onRunFinished failed:', (err as Error).message))
    }
  }

  /** Facts about a step for policy, then the org's decision. */
  async function policyDecision(run: Run, step: Step): Promise<Decision> {
    return db.org(run.orgId, async (q) => {
      const policy = await getPolicy(q, run.orgId, app.config.mode)
      return evaluatePolicy(policy.rules, await stepFacts(q, run.orgId, step))
    })
  }

  function shouldRun(when: Step['when'], last: 'succeeded' | 'failed'): boolean {
    return when === 'always' || (when === 'on_success' && last === 'succeeded') || (when === 'on_failure' && last === 'failed')
  }

  /** Outcome of the last step that actually ran (skipped steps don't count). */
  function lastOutcome(steps: RunStep[], beforeIdx: number): 'succeeded' | 'failed' {
    for (let i = beforeIdx - 1; i >= 0; i--) {
      const s = steps[i]!
      if (s.status === 'succeeded') return 'succeeded'
      if (s.status === 'failed') return 'failed'
    }
    return 'succeeded'
  }

  async function runStep(run: Run, step: Step, rs: RunStep, signal: AbortSignal): Promise<StepResult> {
    const org = await getOrgById(db, run.orgId)
    if (!org) return { status: 'failed', error: 'Org no longer exists' }
    const secrets = new Set<string>()
    const ctx: StepContext = {
      app,
      org,
      run,
      step,
      idx: rs.idx,
      attempt: rs.attempt,
      signal,
      async log(message) {
        await db.org(run.orgId, (q) => appendEvent(q, run.orgId, run.id, 'log', { message: redact(message, secrets) }, rs.idx))
      },
      async emit(type, data) {
        await db.org(run.orgId, (q) => appendEvent(q, run.orgId, run.id, type, redactDeep(data, secrets), rs.idx))
      },
      async secret(key) {
        const v = await db.org(run.orgId, (q) => getSecret(q, app.box, run.orgId, key))
        if (v) secrets.add(v)
        return v
      },
      addSecret(value) {
        if (value) secrets.add(value)
      },
      async addUsage(usage) {
        await db.org(run.orgId, (q) => addRunUsage(q, run, usage))
      },
    }

    // Per-step timeout composes with the worker's signal.
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    let timer: NodeJS.Timeout | undefined
    const timeout = step.timeoutSec
      ? new Promise<StepResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort(new Error('timeout'))
            resolve({ status: 'failed', error: `Step timed out after ${step.timeoutSec}s` })
          }, step.timeoutSec! * 1000)
        })
      : null
    ctx.signal = controller.signal

    try {
      const work = executors[step.kind].execute(ctx)
      const result = await (timeout ? Promise.race([work, timeout]) : work)
      if (result.status === 'waiting') return result
      return {
        status: result.status,
        output: result.output === undefined ? undefined : redactDeep(result.output, secrets),
        error: result.error ? redact(result.error, secrets).slice(0, MAX_ERROR_LEN) : undefined,
      }
    } catch (err) {
      return { status: 'failed', error: redact((err as Error)?.message ?? String(err), secrets).slice(0, MAX_ERROR_LEN) }
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function advance(runId: string, signal: AbortSignal = new AbortController().signal): Promise<AdvanceOutcome> {
    for (;;) {
      const run = await db.system((q) => getRunSystem(q, runId))
      if (!run) return 'missing'
      if (TERMINAL_RUN.includes(run.status)) {
        await db.org(run.orgId, (q) => dequeueRun(q, run.id))
        return 'finished'
      }
      if (run.cancelRequested || signal.aborted) {
        if (run.cancelRequested) {
          await finishRun(run, 'canceled')
          return 'canceled'
        }
        return 'retry' // lease lost: leave the run for whoever holds it now
      }

      let steps = await db.org(run.orgId, (q) => listSteps(q, run.orgId, run.id))

      // Recover steps interrupted by a dead worker.
      for (const s of steps.filter((x) => x.status === 'running')) {
        const spec = run.jobSnapshot.steps[s.idx]!
        await opts.onStepLost?.(run, s.idx).catch((err) => console.error('[engine] onStepLost failed:', (err as Error).message))
        await db.org(run.orgId, async (q) => {
          await appendEvent(q, run.orgId, run.id, 'log', { message: 'Worker lost while this step was running' }, s.idx)
          if (s.attempt <= spec.retries) await updateStep(q, run, s.idx, { status: 'pending', error: 'worker lost' })
          else await updateStep(q, run, s.idx, { status: 'failed', error: 'Worker lost while this step was running' })
        })
      }
      if (steps.some((x) => x.status === 'running')) steps = await db.org(run.orgId, (q) => listSteps(q, run.orgId, run.id))

      if (run.status !== 'running') await db.org(run.orgId, (q) => setRunStatus(q, run, 'running'))

      const next = steps.find((s) => s.status === 'pending')
      if (!next) {
        const failed = steps.find((s) => s.status === 'failed')
        await finishRun(run, failed ? 'failed' : 'succeeded', failed ? `Step "${failed.name}" failed${failed.error ? `: ${failed.error}` : ''}` : undefined)
        return 'finished'
      }

      const spec = run.jobSnapshot.steps[next.idx]!
      if (!shouldRun(spec.when, lastOutcome(steps, next.idx))) {
        await db.org(run.orgId, (q) => updateStep(q, run, next.idx, { status: 'skipped' }))
        continue
      }

      // Org policy, unless a person already approved this step under policy.
      if (spec.kind !== 'approval' && !next.policyCleared) {
        const decision = await policyDecision(run, spec)
        if (decision.effect === 'deny') {
          const rule = decision.rule!
          await db.org(run.orgId, (q) => updateStep(q, run, next.idx, { status: 'failed', error: `Blocked by policy "${rule.name}": ${rule.reason ?? 'not allowed'}` }))
          continue
        }
        if (decision.effect === 'require_approval') {
          const rule = decision.rule!
          await db.org(run.orgId, async (q) => {
            await createApproval(q, run, next.idx, `Policy "${rule.name}" requires approval before "${spec.name}" runs`, rule.minRole ?? 'member', {
              source: 'policy',
              rule: rule.name,
            })
            await updateStep(q, run, next.idx, { status: 'waiting' })
            await setRunStatus(q, run, 'waiting')
            await dequeueRun(q, run.id)
          })
          return 'waiting'
        }
      }

      await db.org(run.orgId, (q) => updateStep(q, run, next.idx, { status: 'running', bumpAttempt: true, error: null }))
      const result = await runStep(run, spec, { ...next, attempt: next.attempt + 1 }, signal)

      if (result.status === 'waiting') {
        await db.org(run.orgId, async (q) => {
          await updateStep(q, run, next.idx, { status: 'waiting' })
          await setRunStatus(q, run, 'waiting')
          await dequeueRun(q, run.id)
        })
        return 'waiting'
      }

      // A cancel that arrived mid-step wins over the step's own result.
      if (await db.system((q) => isCancelRequested(q, run.id))) {
        await finishRun(run, 'canceled')
        return 'canceled'
      }
      if (signal.aborted) return 'retry'

      const attempt = next.attempt + 1
      if (result.status === 'failed' && attempt <= spec.retries) {
        const delay = retryDelay(attempt)
        await db.org(run.orgId, async (q) => {
          await updateStep(q, run, next.idx, { status: 'pending', error: result.error ?? 'failed', output: result.output })
          await appendEvent(q, run.orgId, run.id, 'log', { message: `Attempt ${attempt} failed; retrying in ${Math.round(delay / 1000)}s` }, next.idx)
          await enqueueRun(q, run.orgId, run.id, delay)
        })
        return 'retry'
      }

      await db.org(run.orgId, (q) => updateStep(q, run, next.idx, { status: result.status, output: result.output, error: result.error ?? null }))
    }
  }

  return {
    advance,
    cancelIdleRun: (run) => finishRun(run, 'canceled'),
  }
}
