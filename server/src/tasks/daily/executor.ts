/**
 * Daily-task executor: dispatches on `DailyTask.subtype` to the SSH, IMAP,
 * or HTTP handler and translates the handler result into `TaskRun` state
 * transitions on the shared TaskStore.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Contract
 * ─────────────────────────────────────────────────────────────────────────
 *
 * - Consumes the `TaskExecutor` type from `../executor.ts`. Callers wire
 *   this in via `launchExecution(task, run, store, createDailyExecutor())`.
 * - Only handles `type === 'daily'`. If a caller mistakenly passes a
 *   developmental or routine task, the executor throws immediately so the
 *   outer `launchExecution` catch marks the run failed. This isolates
 *   daily-task concerns from the developmental (Docker) executor.
 * - Every handler call is wrapped: successes append an info log and mark
 *   the run succeeded; failures append an error log carrying the
 *   `sanitizeError`-scrubbed message and re-throw so the outer error
 *   handler sets `run.status = 'failed'`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Handler injection
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Tests supply fake handlers via the `handlers` option so no real network
 * traffic ever happens in the test suite. Production wires the real
 * handlers exported from this module's siblings.
 */

import type { TaskExecutor } from '../executor.js'
import type { TaskStore } from '../store.js'
import type {
  DailyTask,
  EmailConfig,
  HttpConfig,
  LogEntry,
  SshConfig,
  Task,
  TaskRun,
} from '../types.js'
import { fetchDashboard, type DashboardFetchResult } from './dashboardHandler.js'
import { checkEmail, type EmailCheckResult } from './emailHandler.js'
import { runSsh, type SshRunResult } from './sshHandler.js'
import { sanitizeError } from './sanitizeError.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of handler functions the daily executor calls out to. Made
 * injectable so tests can supply deterministic stand-ins.
 */
export interface DailyHandlers {
  ssh: (config: SshConfig) => Promise<SshRunResult>
  email: (config: EmailConfig) => Promise<EmailCheckResult>
  http: (config: HttpConfig) => Promise<DashboardFetchResult>
}

export interface DailyExecutorOptions {
  handlers?: Partial<DailyHandlers>
}

/** Production default: the concrete handlers from this directory. */
const defaultHandlers: DailyHandlers = {
  ssh: (config) => runSsh(config),
  email: (config) => checkEmail(config),
  http: (config) => fetchDashboard(config),
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `TaskExecutor` bound to the given handler set. Any handler not
 * overridden falls back to the production implementation.
 */
export function createDailyExecutor(
  options: DailyExecutorOptions = {},
): TaskExecutor {
  const handlers: DailyHandlers = {
    ssh: options.handlers?.ssh ?? defaultHandlers.ssh,
    email: options.handlers?.email ?? defaultHandlers.email,
    http: options.handlers?.http ?? defaultHandlers.http,
  }

  return async (task: Task, run: TaskRun, store: TaskStore): Promise<void> => {
    if (task.type !== 'daily') {
      // Fail-loud rather than silently succeed — the router only routes
      // daily tasks here, but a future misconfiguration in the executor
      // switchboard should stop the run rather than produce a bogus green.
      throw new Error(`daily executor received non-daily task type "${task.type}"`)
    }
    const daily = task as DailyTask
    appendLog(store, run.id, 'info', `Starting daily/${daily.subtype} task "${task.name}"`)
    store.updateRun(run.id, { status: 'running' })
    store.updateTaskStatus(task.id, 'running')

    try {
      const summary = await runSubtype(daily, handlers)
      appendLog(store, run.id, 'info', summary)
      store.updateRun(run.id, {
        status: 'succeeded',
        completedAt: new Date().toISOString(),
      })
      store.updateTaskStatus(task.id, 'succeeded')
    } catch (err) {
      // The handler already sanitised the message, but wrap once more with
      // the executor's own context so log lines identify the executor layer.
      const wrapped = sanitizeError(err, {
        context: `daily/${daily.subtype}`,
      })
      appendLog(store, run.id, 'error', wrapped.message)
      // Rethrow — the outer `launchExecution` handler is responsible for
      // marking the run failed. We deliberately do not update the run
      // status here to keep failure accounting in exactly one place.
      throw wrapped
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-type dispatch
// ---------------------------------------------------------------------------

async function runSubtype(
  task: DailyTask,
  handlers: DailyHandlers,
): Promise<string> {
  switch (task.subtype) {
    case 'ssh': {
      const result = await handlers.ssh(task.config as SshConfig)
      const failed = result.exitCode !== null && result.exitCode !== 0
      const detail = result.signal
        ? `killed by signal ${result.signal}`
        : `exit ${result.exitCode ?? 'unknown'}`
      if (failed) {
        // A non-zero SSH exit is a real task failure — surface as an
        // error via the throw path so the outer wrapper marks it failed.
        throw new Error(`ssh command failed (${detail})`)
      }
      return `ssh command completed (${detail})`
    }
    case 'email': {
      const result = await handlers.email(task.config as EmailConfig)
      return `imap ${result.folder}: ${result.totalMessages} total, ${result.unreadMessages} unread`
    }
    case 'http': {
      const result = await handlers.http(task.config as HttpConfig)
      // 5xx is a task failure; 4xx we surface but do not throw — an
      // authenticated dashboard returning 401 is a real signal the user
      // wants to see, not a handler error.
      if (result.status >= 500) {
        throw new Error(`http request failed (${result.status} ${result.statusText})`)
      }
      return `http ${result.status} ${result.statusText} (${result.body.length} bytes${result.bodyTruncated ? ', truncated' : ''})`
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendLog(
  store: TaskStore,
  runId: string,
  level: LogEntry['level'],
  message: string,
): void {
  store.appendRunLog(runId, {
    timestamp: new Date().toISOString(),
    level,
    message,
  })
}
