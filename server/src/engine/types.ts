// ─────────────────────────────────────────────────────────────────────────────
// Engine contracts: what a step executor receives and returns.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppContext } from '../http/common.js'
import type { Org } from '../repos/identity.js'
import type { Run } from '../repos/runs.js'
import type { Step } from './spec.js'
import type { HttpRunnerOptions } from '../services/http.js'
import type { SshExecutor } from '../services/ssh.js'
import type { ImapExecutor } from '../services/imap.js'

export interface StepContext {
  app: AppContext
  org: Org
  run: Run
  step: Step
  idx: number
  /** 1 on the first try, 2 on the first retry, … */
  attempt: number
  /** Aborted on cancel, timeout, or loss of the worker's lease. */
  signal: AbortSignal
  /** Appends a redacted `log` event to the run timeline. */
  log(message: string): Promise<void>
  /** Appends a redacted event of any type (agent.message, artifact, …). */
  emit(type: string, data: Record<string, unknown>): Promise<void>
  /** Reads an org credential and registers it for redaction. */
  secret(key: string): Promise<string | null>
  /** Registers a value that must never appear in events or output. */
  addSecret(value: string): void
  /** Adds model spend / agent time to the run's usage. */
  addUsage(usage: { costUsd?: number; agentSeconds?: number }): Promise<void>
}

export type StepResult =
  | { status: 'succeeded' | 'failed'; output?: unknown; error?: string }
  | { status: 'waiting' }

export interface StepExecutor {
  execute(ctx: StepContext): Promise<StepResult>
}

export interface EngineOptions {
  executors?: Partial<Record<Step['kind'], StepExecutor>>
  /** Test doubles for the built-in action executors. */
  actions?: {
    http?: Pick<HttpRunnerOptions, 'fetchImpl' | 'ssrfCheck'>
    sshExecutor?: SshExecutor
    imapExecutor?: ImapExecutor
  }
  /** Delay before a failed step is retried (ms). Default: 5s × attempt. */
  retryDelayMs?: (attempt: number) => number
  /** Called when a step is found orphaned by a dead worker (e.g. to kill its container). */
  onStepLost?: (run: Run, idx: number) => Promise<void>
  /** Called once when a run reaches a terminal status. */
  onRunFinished?: (run: Run) => Promise<void>
}
