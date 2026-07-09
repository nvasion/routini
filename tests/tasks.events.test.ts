/**
 * Unit tests for the TaskRunEventBus and the store's event-emission hooks.
 *
 * These are HTTP-free — they exercise the pub/sub layer directly so a
 * regression in event wiring surfaces here before it can affect the SSE
 * endpoint tests.
 */

import { describe, expect, it, vi } from 'vitest'
import { TaskRunEventBus } from '../server/src/tasks/events.js'
import type { TaskRunEvent } from '../server/src/tasks/events.js'
import { TaskStore } from '../server/src/tasks/store.js'
import type { CreateDailyTaskInput } from '../server/src/tasks/types.js'

const dailyInput: CreateDailyTaskInput = {
  type: 'daily',
  userId: 'user-1',
  name: 'SSH check',
  subtype: 'ssh',
  config: { host: 'example.com', username: 'deploy', command: 'uptime' },
}

describe('TaskRunEventBus', () => {
  it('delivers emitted events to every registered listener', () => {
    const bus = new TaskRunEventBus()
    const seenA: TaskRunEvent[] = []
    const seenB: TaskRunEvent[] = []
    bus.on((e) => seenA.push(e))
    bus.on((e) => seenB.push(e))

    bus.emit({ type: 'task-status', taskId: 't1', status: 'running' })

    expect(seenA).toHaveLength(1)
    expect(seenB).toHaveLength(1)
    expect(seenA[0]).toMatchObject({ type: 'task-status', taskId: 't1' })
  })

  it('the returned unsubscribe function removes the listener', () => {
    const bus = new TaskRunEventBus()
    const seen: TaskRunEvent[] = []
    const off = bus.on((e) => seen.push(e))

    bus.emit({ type: 'task-status', taskId: 't1', status: 'running' })
    off()
    bus.emit({ type: 'task-status', taskId: 't1', status: 'succeeded' })

    expect(seen).toHaveLength(1)
    expect(bus.listenerCount()).toBe(0)
  })

  it('isolates listener errors so a bad subscriber cannot break the bus', () => {
    const bus = new TaskRunEventBus()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const seen: TaskRunEvent[] = []

    bus.on(() => {
      throw new Error('subscriber crashed')
    })
    bus.on((e) => seen.push(e))

    bus.emit({ type: 'task-status', taskId: 't1', status: 'running' })

    expect(seen).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('TaskStore — event emission', () => {
  it('emits task-created on createDailyTask', () => {
    const bus = new TaskRunEventBus()
    const events: TaskRunEvent[] = []
    bus.on((e) => events.push(e))
    const store = new TaskStore({ bus })

    const task = store.createDailyTask(dailyInput)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'task-created',
      taskId: task.id,
      taskType: 'daily',
    })
  })

  it('emits task-created for developmental and routine variants too', () => {
    const bus = new TaskRunEventBus()
    const events: TaskRunEvent[] = []
    bus.on((e) => events.push(e))
    const store = new TaskStore({ bus })

    store.createDevelopmentalTask({
      type: 'developmental',
      userId: 'u',
      name: 'x',
      repoUrl: 'https://github.com/x/y',
      agentName: 'claude-code',
    })
    store.createRoutineTask({
      type: 'routine',
      userId: 'u',
      name: 'r',
      steps: [{ taskId: 'placeholder' }],
    })

    const types = events.map((e) => (e.type === 'task-created' ? e.taskType : null))
    expect(types).toEqual(['developmental', 'routine'])
  })

  it('emits task-status only when the status actually changes', () => {
    const bus = new TaskRunEventBus()
    const events: TaskRunEvent[] = []
    bus.on((e) => events.push(e))
    const store = new TaskStore({ bus })
    const task = store.createDailyTask(dailyInput)
    events.length = 0

    store.updateTaskStatus(task.id, 'queued')
    store.updateTaskStatus(task.id, 'queued') // no-op — same status
    store.updateTaskStatus(task.id, 'running')

    const statuses = events
      .filter((e) => e.type === 'task-status')
      .map((e) => (e.type === 'task-status' ? e.status : null))
    expect(statuses).toEqual(['queued', 'running'])
  })

  it('emits run-created and run-status when a run is created and progressed', () => {
    const bus = new TaskRunEventBus()
    const events: TaskRunEvent[] = []
    bus.on((e) => events.push(e))
    const store = new TaskStore({ bus })
    const task = store.createDailyTask(dailyInput)
    events.length = 0

    const run = store.createRun(task.id)!
    store.updateRun(run.id, { status: 'running' })
    store.updateRun(run.id, {
      status: 'succeeded',
      completedAt: '2025-01-01T00:00:00Z',
    })
    // Repeat status = no additional event
    store.updateRun(run.id, { status: 'succeeded' })

    const runStatusEvents = events.filter((e) => e.type === 'run-status')
    expect(runStatusEvents).toHaveLength(2)
    expect(events[0].type).toBe('run-created')
    expect(runStatusEvents[1]).toMatchObject({
      status: 'succeeded',
      completedAt: '2025-01-01T00:00:00Z',
    })
  })

  it('emits run-log on every appended log entry', () => {
    const bus = new TaskRunEventBus()
    const events: TaskRunEvent[] = []
    bus.on((e) => events.push(e))
    const store = new TaskStore({ bus })
    const task = store.createDailyTask(dailyInput)
    const run = store.createRun(task.id)!
    events.length = 0

    store.appendRunLog(run.id, {
      timestamp: '2025-01-01T00:00:00Z',
      message: 'hello',
      level: 'info',
    })
    store.appendRunLog(run.id, {
      timestamp: '2025-01-01T00:00:01Z',
      message: 'oops',
      level: 'error',
    })

    const logs = events
      .filter((e) => e.type === 'run-log')
      .map((e) => (e.type === 'run-log' ? e.log.message : null))
    expect(logs).toEqual(['hello', 'oops'])
  })

  it('emits task-deleted when a task is removed', () => {
    const bus = new TaskRunEventBus()
    const events: TaskRunEvent[] = []
    bus.on((e) => events.push(e))
    const store = new TaskStore({ bus })
    const task = store.createDailyTask(dailyInput)
    events.length = 0

    const removed = store.deleteTask(task.id)
    const missing = store.deleteTask('does-not-exist')

    expect(removed).toBe(true)
    expect(missing).toBe(false)
    expect(events).toEqual([{ type: 'task-deleted', taskId: task.id }])
  })

  it('is silent when constructed without a bus', () => {
    // No bus provided — mutations should still succeed but emit nothing.
    const store = new TaskStore()
    const task = store.createDailyTask(dailyInput)
    // If the store attempted to emit on undefined, this would throw.
    expect(store.updateTaskStatus(task.id, 'running')?.status).toBe('running')
    expect(store.deleteTask(task.id)).toBe(true)
  })
})
