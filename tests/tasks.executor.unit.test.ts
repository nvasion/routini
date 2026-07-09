/**
 * Unit tests for the task executor layer:
 *   - `defaultExecutor`       — the simulated no-op executor used by tests and
 *                               as a fallback when no type-specific executor is
 *                               registered.
 *   - `createDispatchExecutor` — factory that routes execution to a type-keyed
 *                               executor, falling back to `defaultExecutor`.
 *   - `launchExecution` edge cases — boundary values for the `maxAttempts`
 *                               parameter (0, negative, NaN, Infinity) that
 *                               complement the retry-loop tests already in
 *                               `tasks.daily.executor.test.ts`.
 *
 * All tests operate against an in-memory `TaskStore` without spinning up an
 * HTTP server — they exercise the service layer directly.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  defaultExecutor,
  createDispatchExecutor,
  launchExecution,
  type TaskExecutor,
} from '../server/src/tasks/executor.js'
import { TaskStore } from '../server/src/tasks/store.js'
import type {
  CreateDailyTaskInput,
  CreateDevelopmentalTaskInput,
  CreateRoutineTaskInput,
} from '../server/src/tasks/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(): TaskStore {
  return new TaskStore()
}

const dailyInput: CreateDailyTaskInput = {
  type: 'daily',
  userId: 'user-1',
  name: 'Test SSH task',
  subtype: 'ssh',
  config: { host: 'example.com', username: 'deploy', command: 'uptime' },
}

const devInput: CreateDevelopmentalTaskInput = {
  type: 'developmental',
  userId: 'user-1',
  name: 'Test dev task',
  repoUrl: 'https://github.com/example/repo',
  agentName: 'claude-code',
  branchName: 'feature/test',
}

const routineInput: CreateRoutineTaskInput = {
  type: 'routine',
  userId: 'user-1',
  name: 'Test routine',
  steps: [{ taskId: 'placeholder' }],
}

/** Wait for all pending setImmediate callbacks to drain. */
function flushImmediate(rounds = 8): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return Array.from({ length: rounds }).reduce<Promise<void>>(
    (p) => p.then(() => new Promise((r) => setImmediate(r))),
    Promise.resolve(),
  )
}

// ---------------------------------------------------------------------------
// defaultExecutor
// ---------------------------------------------------------------------------

describe('defaultExecutor — state transitions', () => {
  it('transitions the run from queued → running → succeeded', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    await defaultExecutor(task, run, store)

    const finalRun = store.getRun(run.id)!
    expect(finalRun.status).toBe('succeeded')
    expect(finalRun.completedAt).toBeTruthy()
    expect(Number.isNaN(new Date(finalRun.completedAt!).getTime())).toBe(false)
  })

  it('updates the task status through running → succeeded', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    await defaultExecutor(task, run, store)

    expect(store.getTask(task.id)!.status).toBe('succeeded')
  })

  it('appends exactly two log entries during execution', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    await defaultExecutor(task, run, store)

    const finalRun = store.getRun(run.id)!
    expect(finalRun.logs).toHaveLength(2)
    expect(finalRun.logs.every((l) => l.level === 'info')).toBe(true)
  })

  it('log entries mention the task name and type', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    await defaultExecutor(task, run, store)

    const finalRun = store.getRun(run.id)!
    const messages = finalRun.logs.map((l) => l.message)
    // First entry announces the start, second announces completion
    expect(messages[0]).toContain('daily')
    expect(messages[0]).toContain(task.name)
    expect(messages[1]).toContain(task.name)
    expect(messages[1].toLowerCase()).toContain('completed')
  })

  it('log entries have valid ISO timestamps', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    await defaultExecutor(task, run, store)

    const finalRun = store.getRun(run.id)!
    for (const entry of finalRun.logs) {
      expect(Number.isNaN(new Date(entry.timestamp).getTime())).toBe(false)
    }
  })

  it('works for developmental tasks', async () => {
    const store = makeStore()
    const task = store.createDevelopmentalTask(devInput)
    const run = store.createRun(task.id)!

    await defaultExecutor(task, run, store)

    expect(store.getRun(run.id)!.status).toBe('succeeded')
    expect(store.getTask(task.id)!.status).toBe('succeeded')
  })

  it('works for routine tasks', async () => {
    const store = makeStore()
    const task = store.createRoutineTask(routineInput)
    const run = store.createRun(task.id)!

    await defaultExecutor(task, run, store)

    expect(store.getRun(run.id)!.status).toBe('succeeded')
    expect(store.getTask(task.id)!.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// createDispatchExecutor
// ---------------------------------------------------------------------------

describe('createDispatchExecutor — type routing', () => {
  it('calls the "daily" executor for a daily task', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    const dailyExec = vi.fn<TaskExecutor>(async () => undefined)
    const dispatch = createDispatchExecutor({ daily: dailyExec })

    await dispatch(task, run, store)

    expect(dailyExec).toHaveBeenCalledTimes(1)
    expect(dailyExec).toHaveBeenCalledWith(task, run, store)
  })

  it('calls the "developmental" executor for a developmental task', async () => {
    const store = makeStore()
    const task = store.createDevelopmentalTask(devInput)
    const run = store.createRun(task.id)!

    const devExec = vi.fn<TaskExecutor>(async () => undefined)
    const dispatch = createDispatchExecutor({ developmental: devExec })

    await dispatch(task, run, store)

    expect(devExec).toHaveBeenCalledTimes(1)
    expect(devExec).toHaveBeenCalledWith(task, run, store)
  })

  it('calls the "routine" executor for a routine task', async () => {
    const store = makeStore()
    const task = store.createRoutineTask(routineInput)
    const run = store.createRun(task.id)!

    const routineExec = vi.fn<TaskExecutor>(async () => undefined)
    const dispatch = createDispatchExecutor({ routine: routineExec })

    await dispatch(task, run, store)

    expect(routineExec).toHaveBeenCalledTimes(1)
    expect(routineExec).toHaveBeenCalledWith(task, run, store)
  })

  it('falls back to defaultExecutor when the task type has no registered handler', async () => {
    const store = makeStore()
    // Create a daily task but register only a developmental handler
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    const devExec = vi.fn<TaskExecutor>(async () => undefined)
    const dispatch = createDispatchExecutor({ developmental: devExec })

    // Should not throw and should use defaultExecutor
    await dispatch(task, run, store)

    expect(devExec).not.toHaveBeenCalled()
    // The default executor marks the run as succeeded
    expect(store.getRun(run.id)!.status).toBe('succeeded')
  })

  it('falls back to defaultExecutor for an empty executor map', async () => {
    const store = makeStore()
    const task = store.createDevelopmentalTask(devInput)
    const run = store.createRun(task.id)!

    const dispatch = createDispatchExecutor({})

    await dispatch(task, run, store)

    // defaultExecutor ran and succeeded
    expect(store.getRun(run.id)!.status).toBe('succeeded')
  })

  it('does not call unrelated type handlers', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    const devExec = vi.fn<TaskExecutor>(async () => undefined)
    const routineExec = vi.fn<TaskExecutor>(async () => undefined)
    const dispatch = createDispatchExecutor({ developmental: devExec, routine: routineExec })

    await dispatch(task, run, store)

    expect(devExec).not.toHaveBeenCalled()
    expect(routineExec).not.toHaveBeenCalled()
  })

  it('propagates errors thrown by the specific executor', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!

    const failingExec: TaskExecutor = async () => {
      throw new Error('specific executor failed')
    }
    const dispatch = createDispatchExecutor({ daily: failingExec })

    await expect(dispatch(task, run, store)).rejects.toThrow('specific executor failed')
  })
})

// ---------------------------------------------------------------------------
// launchExecution — clampMaxAttempts edge cases
// ---------------------------------------------------------------------------

describe('launchExecution — maxAttempts boundary values', () => {
  /**
   * Shared helper: run a permanently-failing executor and wait for the retry
   * loop to exhaust. Returns the number of times the executor was called.
   */
  async function countAttempts(maxAttempts: number | undefined): Promise<number> {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!
    let calls = 0
    const failing: TaskExecutor = async () => {
      calls += 1
      throw new Error(`attempt ${calls} failed`)
    }
    launchExecution(task, run, store, failing, {
      maxAttempts,
      baseBackoffMs: 0,
      delay: async () => undefined,
    })
    await flushImmediate()
    return calls
  }

  it('clamps maxAttempts: 0 to 1 — executor is called exactly once', async () => {
    const calls = await countAttempts(0)
    expect(calls).toBe(1)
  })

  it('clamps maxAttempts: -1 to 1 — executor is called exactly once', async () => {
    const calls = await countAttempts(-1)
    expect(calls).toBe(1)
  })

  it('treats maxAttempts: NaN as the default (3)', async () => {
    const calls = await countAttempts(Number.NaN)
    expect(calls).toBe(3)
  })

  it('treats maxAttempts: Infinity as the default (3)', async () => {
    const calls = await countAttempts(Number.POSITIVE_INFINITY)
    expect(calls).toBe(3)
  })

  it('treats maxAttempts: -Infinity as the default (3)', async () => {
    const calls = await countAttempts(Number.NEGATIVE_INFINITY)
    expect(calls).toBe(3)
  })

  it('treats maxAttempts: undefined as the default (3)', async () => {
    const calls = await countAttempts(undefined)
    expect(calls).toBe(3)
  })

  it('floors non-integer values — maxAttempts: 2.9 behaves as 2', async () => {
    const calls = await countAttempts(2.9)
    expect(calls).toBe(2)
  })

  it('marks the task "failed" after the (clamped) last attempt', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!
    const failing: TaskExecutor = async () => {
      throw new Error('always fails')
    }
    launchExecution(task, run, store, failing, {
      maxAttempts: 0, // clamped → 1
      baseBackoffMs: 0,
      delay: async () => undefined,
    })
    await flushImmediate()
    expect(store.getTask(task.id)!.status).toBe('failed')
  })

  it('marks the task "succeeded" after a successful first attempt regardless of maxAttempts', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!
    let called = 0
    const succeeding: TaskExecutor = async () => {
      called += 1
      // Manually mirror what a real executor does on success
      store.updateRun(run.id, { status: 'succeeded', completedAt: new Date().toISOString() })
      store.updateTaskStatus(task.id, 'succeeded')
    }
    launchExecution(task, run, store, succeeding, {
      maxAttempts: 3,
      baseBackoffMs: 0,
      delay: async () => undefined,
    })
    await flushImmediate()
    expect(called).toBe(1)
    expect(store.getTask(task.id)!.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// launchExecution — task deleted mid-retry
// ---------------------------------------------------------------------------

describe('launchExecution — task deleted during retry', () => {
  it('abandons the retry loop cleanly when the task is deleted between attempts', async () => {
    const store = makeStore()
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!
    let attempt = 0

    const failing: TaskExecutor = async () => {
      attempt += 1
      if (attempt === 1) {
        // Delete the task after the first failure so the retry loop has
        // no task to re-queue.
        store.deleteTask(task.id)
      }
      throw new Error(`attempt ${attempt} failed`)
    }

    launchExecution(task, run, store, failing, {
      maxAttempts: 3,
      baseBackoffMs: 0,
      delay: async () => undefined,
    })
    await flushImmediate()

    // Only the first attempt ran; the store has no task left to re-queue.
    expect(attempt).toBe(1)
    // The task has been deleted — neither succeeded nor failed in the store.
    expect(store.getTask(task.id)).toBeUndefined()
  })
})
