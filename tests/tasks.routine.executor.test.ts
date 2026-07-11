/**
 * Unit tests for the routine task executor.
 *
 * All tests operate directly against an in-memory TaskStore without spinning
 * up an HTTP server. A stub sub-executor is injected so the tests are fast,
 * deterministic, and free of real task-type logic.
 *
 * Covers:
 *  - Happy path: all steps run in order → routine succeeds
 *  - Condition gate: step with unmet condition is skipped
 *  - Condition gate with context: skipped steps do not update the context
 *  - Failure propagation: sub-task failure → routine throws RoutineStepError
 *  - Sub-executor throwing: exception is wrapped and re-thrown
 *  - Authorization: step referencing another user's task is rejected
 *  - Missing task: step referencing a non-existent task is rejected
 *  - Nested routine: step of type 'routine' is rejected
 *  - Empty context: first-step condition that checks previous.status === 'succeeded'
 *    evaluates to false → step is skipped
 *  - Sub-run cleanup: dangling running sub-run is set to failed on throw
 *  - Non-routine task: throws if called with wrong task type
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoutineExecutor, RoutineStepError } from '../server/src/tasks/routine/executor.js'
import { TaskStore } from '../server/src/tasks/store.js'
import type { TaskExecutor } from '../server/src/tasks/executor.js'
import type {
  CreateDailyTaskInput,
  CreateRoutineTaskInput,
  TaskRun,
} from '../server/src/tasks/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_A = 'user-a'
const USER_B = 'user-b'

const dailyInput = (overrides: Partial<CreateDailyTaskInput> = {}): CreateDailyTaskInput => ({
  type: 'daily',
  userId: USER_A,
  name: 'SSH health check',
  subtype: 'ssh',
  config: { host: 'example.com', username: 'deploy', command: 'uptime' },
  ...overrides,
})

const routineInput = (steps: CreateRoutineTaskInput['steps']): CreateRoutineTaskInput => ({
  type: 'routine',
  userId: USER_A,
  name: 'Test routine',
  steps,
})

/**
 * A sub-executor stub that immediately marks the sub-run as succeeded.
 * Tests that need failure inject a different stub.
 */
const succeedingSubExec: TaskExecutor = async (_task, run, store) => {
  store.updateRun(run.id, { status: 'running' })
  store.updateTaskStatus(_task.id, 'running')
  store.updateRun(run.id, { status: 'succeeded', completedAt: new Date().toISOString() })
  store.updateTaskStatus(_task.id, 'succeeded')
}

/**
 * A sub-executor that always throws without updating the sub-run.
 */
const throwingSubExec: TaskExecutor = async () => {
  throw new Error('sub-task failed')
}

/**
 * A sub-executor that marks the sub-run as failed then throws.
 */
const failingSubExec: TaskExecutor = async (_task, run, store) => {
  store.updateRun(run.id, { status: 'running' })
  store.updateTaskStatus(_task.id, 'running')
  store.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() })
  store.updateTaskStatus(_task.id, 'failed')
  throw new Error('sub-task produced failure status')
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeStore(): TaskStore {
  return new TaskStore()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRoutineExecutor — happy path', () => {
  let store: TaskStore

  beforeEach(() => {
    store = makeStore()
  })

  it('executes all steps in order and marks the routine run succeeded', async () => {
    const sub1 = store.createDailyTask(dailyInput({ name: 'Step 1' }))
    const sub2 = store.createDailyTask(dailyInput({ name: 'Step 2' }))
    const routine = store.createRoutineTask(
      routineInput([{ taskId: sub1.id }, { taskId: sub2.id }]),
    )
    const run = store.createRun(routine.id)!

    const callOrder: string[] = []
    const trackingExec: TaskExecutor = async (task, subRun, s) => {
      callOrder.push(task.name)
      await succeedingSubExec(task, subRun, s)
    }

    const executor = createRoutineExecutor(trackingExec)
    await executor(routine, run, store)

    expect(callOrder).toEqual(['Step 1', 'Step 2'])
    expect(store.getRun(run.id)!.status).toBe('succeeded')
    expect(store.getRun(run.id)!.completedAt).toBeTruthy()
    expect(store.getTask(routine.id)!.status).toBe('succeeded')
  })

  it('creates a sub-run for each step', async () => {
    const sub = store.createDailyTask(dailyInput())
    const routine = store.createRoutineTask(routineInput([{ taskId: sub.id }]))
    const run = store.createRun(routine.id)!

    const executor = createRoutineExecutor(succeedingSubExec)
    await executor(routine, run, store)

    const subRuns = store.listRunsForTask(sub.id)
    expect(subRuns).toHaveLength(1)
    expect(subRuns[0].status).toBe('succeeded')
  })

  it('marks the routine run as running before executing steps', async () => {
    const sub = store.createDailyTask(dailyInput())
    const routine = store.createRoutineTask(routineInput([{ taskId: sub.id }]))
    const run = store.createRun(routine.id)!

    let statusDuringExec: string | undefined
    const exec: TaskExecutor = async (task, subRun, s) => {
      statusDuringExec = store.getRun(run.id)!.status
      await succeedingSubExec(task, subRun, s)
    }

    const executor = createRoutineExecutor(exec)
    await executor(routine, run, store)

    expect(statusDuringExec).toBe('running')
  })

  it('appends logs for start, each step, and completion', async () => {
    const sub = store.createDailyTask(dailyInput({ name: 'My task' }))
    const routine = store.createRoutineTask(routineInput([{ taskId: sub.id }]))
    const run = store.createRun(routine.id)!

    const executor = createRoutineExecutor(succeedingSubExec)
    await executor(routine, run, store)

    const logs = store.getRun(run.id)!.logs.map((l) => l.message)
    expect(logs.some((m) => m.includes('Starting routine'))).toBe(true)
    expect(logs.some((m) => m.includes('My task'))).toBe(true)
    expect(logs.some((m) => m.toLowerCase().includes('completed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Condition gate
// ---------------------------------------------------------------------------

describe('createRoutineExecutor — condition gate', () => {
  let store: TaskStore

  beforeEach(() => {
    store = makeStore()
  })

  it('skips a step whose condition evaluates to false (no previous result)', async () => {
    const sub = store.createDailyTask(dailyInput({ name: 'Conditional step' }))
    const routine = store.createRoutineTask(
      routineInput([{ taskId: sub.id, condition: "previous.status === 'succeeded'" }]),
    )
    const run = store.createRun(routine.id)!

    const called = vi.fn()
    const executor = createRoutineExecutor(async (task, subRun, s) => {
      called()
      await succeedingSubExec(task, subRun, s)
    })

    await executor(routine, run, store)

    expect(called).not.toHaveBeenCalled()
    // Routine still succeeds (skipping is not failure)
    expect(store.getRun(run.id)!.status).toBe('succeeded')
    expect(store.getRun(run.id)!.logs.some((l) => l.message.includes('skipping'))).toBe(true)
  })

  it('runs a step whose condition evaluates to true', async () => {
    const sub1 = store.createDailyTask(dailyInput({ name: 'First' }))
    const sub2 = store.createDailyTask(dailyInput({ name: 'Second' }))
    const routine = store.createRoutineTask(
      routineInput([
        { taskId: sub1.id },
        { taskId: sub2.id, condition: "previous.status === 'succeeded'" },
      ]),
    )
    const run = store.createRun(routine.id)!

    const callOrder: string[] = []
    const executor = createRoutineExecutor(async (task, subRun, s) => {
      callOrder.push(task.name)
      await succeedingSubExec(task, subRun, s)
    })

    await executor(routine, run, store)

    expect(callOrder).toEqual(['First', 'Second'])
    expect(store.getRun(run.id)!.status).toBe('succeeded')
  })

  it('does not update the context for skipped steps', async () => {
    // Step 1: succeeds
    // Step 2: condition not met → skipped
    // Step 3: condition checks previous.status === 'succeeded' → still true (step 1)
    const sub1 = store.createDailyTask(dailyInput({ name: 'A' }))
    const sub2 = store.createDailyTask(dailyInput({ name: 'B' }))
    const sub3 = store.createDailyTask(dailyInput({ name: 'C' }))

    const routine = store.createRoutineTask(
      routineInput([
        { taskId: sub1.id },
        // This step is skipped (previous succeeded, condition checks for failed)
        { taskId: sub2.id, condition: "previous.status === 'failed'" },
        // After skip, previous still refers to step 1's succeeded result
        { taskId: sub3.id, condition: "previous.status === 'succeeded'" },
      ]),
    )
    const run = store.createRun(routine.id)!

    const callOrder: string[] = []
    const executor = createRoutineExecutor(async (task, subRun, s) => {
      callOrder.push(task.name)
      await succeedingSubExec(task, subRun, s)
    })

    await executor(routine, run, store)

    expect(callOrder).toEqual(['A', 'C']) // B was skipped
    expect(store.getRun(run.id)!.status).toBe('succeeded')
  })

  it('handles !== condition: runs when previous.status !== specified', async () => {
    const sub1 = store.createDailyTask(dailyInput({ name: 'X' }))
    const sub2 = store.createDailyTask(dailyInput({ name: 'Y' }))
    const routine = store.createRoutineTask(
      routineInput([
        { taskId: sub1.id },
        // previous is 'succeeded', condition checks !== 'failed' → true → runs
        { taskId: sub2.id, condition: "previous.status !== 'failed'" },
      ]),
    )
    const run = store.createRun(routine.id)!

    const called: string[] = []
    const executor = createRoutineExecutor(async (task, subRun, s) => {
      called.push(task.name)
      await succeedingSubExec(task, subRun, s)
    })

    await executor(routine, run, store)

    expect(called).toEqual(['X', 'Y'])
  })
})

// ---------------------------------------------------------------------------
// Failure propagation
// ---------------------------------------------------------------------------

describe('createRoutineExecutor — failure propagation', () => {
  let store: TaskStore

  beforeEach(() => {
    store = makeStore()
  })

  it('throws RoutineStepError when sub-executor throws', async () => {
    const sub = store.createDailyTask(dailyInput())
    const routine = store.createRoutineTask(routineInput([{ taskId: sub.id }]))
    const run = store.createRun(routine.id)!

    const executor = createRoutineExecutor(throwingSubExec)
    await expect(executor(routine, run, store)).rejects.toThrow(RoutineStepError)
  })

  it('includes the step number in the thrown error', async () => {
    const sub1 = store.createDailyTask(dailyInput({ name: 'OK' }))
    const sub2 = store.createDailyTask(dailyInput({ name: 'Bad' }))
    const routine = store.createRoutineTask(
      routineInput([{ taskId: sub1.id }, { taskId: sub2.id }]),
    )
    const run = store.createRun(routine.id)!

    let firstCalled = false
    const partialFail: TaskExecutor = async (task, subRun, s) => {
      if (!firstCalled) {
        firstCalled = true
        await succeedingSubExec(task, subRun, s)
      } else {
        await throwingSubExec(task, subRun, s)
      }
    }

    const executor = createRoutineExecutor(partialFail)
    const err = await executor(routine, run, store).catch((e) => e)
    expect(err).toBeInstanceOf(RoutineStepError)
    expect((err as RoutineStepError).stepNumber).toBe(2)
  })

  it('cleans up the sub-run if the sub-executor throws without setting a terminal status', async () => {
    const sub = store.createDailyTask(dailyInput())
    const routine = store.createRoutineTask(routineInput([{ taskId: sub.id }]))
    const run = store.createRun(routine.id)!

    // throwingSubExec never calls store.updateRun — the executor must clean up
    const executor = createRoutineExecutor(throwingSubExec)
    await executor(routine, run, store).catch(() => undefined)

    const subRuns = store.listRunsForTask(sub.id)
    expect(subRuns).toHaveLength(1)
    expect(subRuns[0].status).toBe('failed')
  })

  it('throws RoutineStepError when sub-run ends in a non-succeeded status', async () => {
    const sub = store.createDailyTask(dailyInput())
    const routine = store.createRoutineTask(routineInput([{ taskId: sub.id }]))
    const run = store.createRun(routine.id)!

    const executor = createRoutineExecutor(failingSubExec)
    await expect(executor(routine, run, store)).rejects.toThrow(RoutineStepError)
  })

  it('stops after the first failing step — does not run subsequent steps', async () => {
    const sub1 = store.createDailyTask(dailyInput({ name: 'Fail' }))
    const sub2 = store.createDailyTask(dailyInput({ name: 'Should not run' }))
    const routine = store.createRoutineTask(
      routineInput([{ taskId: sub1.id }, { taskId: sub2.id }]),
    )
    const run = store.createRun(routine.id)!

    const secondCalled = vi.fn()
    let first = true
    const exec: TaskExecutor = async (task, subRun, s) => {
      if (first) {
        first = false
        await throwingSubExec(task, subRun, s)
      } else {
        secondCalled()
        await succeedingSubExec(task, subRun, s)
      }
    }

    const executor = createRoutineExecutor(exec)
    await executor(routine, run, store).catch(() => undefined)

    expect(secondCalled).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Authorization & referential integrity
// ---------------------------------------------------------------------------

describe('createRoutineExecutor — authorization', () => {
  let store: TaskStore

  beforeEach(() => {
    store = makeStore()
  })

  it('throws RoutineStepError for a step referencing a task owned by another user', async () => {
    const otherUserTask = store.createDailyTask(dailyInput({ userId: USER_B }))
    const routine = store.createRoutineTask(routineInput([{ taskId: otherUserTask.id }]))
    const run = store.createRun(routine.id)!

    const executor = createRoutineExecutor(succeedingSubExec)
    const err = await executor(routine, run, store).catch((e) => e)
    expect(err).toBeInstanceOf(RoutineStepError)
    expect(err.message).toContain('not found or not accessible')
  })

  it('throws RoutineStepError for a step referencing a non-existent task', async () => {
    const routine = store.createRoutineTask(
      routineInput([{ taskId: 'does-not-exist' }]),
    )
    const run = store.createRun(routine.id)!

    const executor = createRoutineExecutor(succeedingSubExec)
    const err = await executor(routine, run, store).catch((e) => e)
    expect(err).toBeInstanceOf(RoutineStepError)
    expect(err.message).toContain('not found or not accessible')
  })

  it('throws RoutineStepError for a step referencing a nested routine', async () => {
    const nested = store.createRoutineTask(routineInput([]))
    // Update the nested routine to reference itself (just need a routine task)
    const outer = store.createRoutineTask(routineInput([{ taskId: nested.id }]))
    const run = store.createRun(outer.id)!

    const executor = createRoutineExecutor(succeedingSubExec)
    const err = await executor(outer, run, store).catch((e) => e)
    expect(err).toBeInstanceOf(RoutineStepError)
    expect(err.message).toContain('Nested routines are not supported')
  })
})

// ---------------------------------------------------------------------------
// Non-routine task guard
// ---------------------------------------------------------------------------

describe('createRoutineExecutor — type guard', () => {
  it('throws immediately when called with a non-routine task', async () => {
    const store = makeStore()
    const daily = store.createDailyTask(dailyInput())
    const run = store.createRun(daily.id)!

    const executor = createRoutineExecutor(succeedingSubExec)
    await expect(executor(daily, run, store)).rejects.toThrow('[routine]')
  })
})

// ---------------------------------------------------------------------------
// RoutineStepError shape
// ---------------------------------------------------------------------------

describe('RoutineStepError', () => {
  it('carries the step number as a property', () => {
    const err = new RoutineStepError(3, 'something went wrong')
    expect(err.stepNumber).toBe(3)
    expect(err.message).toContain('Step 3')
    expect(err.name).toBe('RoutineStepError')
  })

  it('is an instance of Error', () => {
    const err = new RoutineStepError(1, 'oops')
    expect(err).toBeInstanceOf(Error)
  })
})
