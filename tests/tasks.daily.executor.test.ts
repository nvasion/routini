/**
 * Tests for the daily-task executor and its interaction with the outer
 * retry / event-bus layer in `launchExecution`.
 */

import { describe, expect, it, vi } from 'vitest'
import { createDailyExecutor } from '../server/src/tasks/daily/executor.js'
import {
  TaskRunEventBus,
  launchExecution,
  type TaskRunEvent,
} from '../server/src/tasks/executor.js'
import { TaskStore } from '../server/src/tasks/store.js'
import type { DailyTask } from '../server/src/tasks/types.js'

function seedDailyTask(store: TaskStore, subtype: 'ssh' | 'email' | 'http'): DailyTask {
  const task = store.createDailyTask({
    type: 'daily',
    userId: 'u1',
    name: `${subtype} task`,
    subtype,
    config:
      subtype === 'ssh'
        ? { host: 'example.com', username: 'deploy', command: 'uptime', password: 'pw' }
        : subtype === 'email'
        ? { host: 'imap.example.com', username: 'alice', password: 'pw' }
        : { url: 'https://example.com/status' },
  })
  return task as DailyTask
}

describe('createDailyExecutor — subtype dispatch', () => {
  it('runs the ssh handler for subtype "ssh" and marks the run succeeded', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'ssh')
    const run = store.createRun(task.id)!
    const executor = createDailyExecutor({
      handlers: {
        ssh: async () => ({
          exitCode: 0,
          signal: null,
          stdout: 'ok',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      },
    })
    await executor(task, run, store)
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('succeeded')
    expect(updated?.logs.some((l) => l.message.includes('ssh command completed'))).toBe(true)
  })

  it('throws when the ssh command exits non-zero (marks the run as failed via outer loop)', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'ssh')
    const run = store.createRun(task.id)!
    const executor = createDailyExecutor({
      handlers: {
        ssh: async () => ({
          exitCode: 3,
          signal: null,
          stdout: '',
          stderr: 'bad',
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      },
    })
    await expect(executor(task, run, store)).rejects.toThrow(/exit 3/)
    // The daily executor writes an error log line before rethrowing.
    const updated = store.getRun(run.id)
    expect(updated?.logs.some((l) => l.level === 'error')).toBe(true)
  })

  it('runs the email handler for subtype "email"', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'email')
    const run = store.createRun(task.id)!
    const executor = createDailyExecutor({
      handlers: {
        email: async () => ({ totalMessages: 12, unreadMessages: 3, folder: 'INBOX' }),
      },
    })
    await executor(task, run, store)
    const updated = store.getRun(run.id)
    expect(updated?.status).toBe('succeeded')
    expect(updated?.logs.some((l) => l.message.includes('12 total, 3 unread'))).toBe(true)
  })

  it('runs the http handler for subtype "http" and surfaces 5xx as failure', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'http')
    const run = store.createRun(task.id)!
    const executor = createDailyExecutor({
      handlers: {
        http: async () => ({
          status: 500,
          statusText: 'Server Error',
          url: 'https://example.com/status',
          body: 'boom',
          bodyTruncated: false,
          headers: {},
        }),
      },
    })
    await expect(executor(task, run, store)).rejects.toThrow(/500/)
  })

  it('surfaces 4xx as success (auth challenge is a real signal, not a handler bug)', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'http')
    const run = store.createRun(task.id)!
    const executor = createDailyExecutor({
      handlers: {
        http: async () => ({
          status: 401,
          statusText: 'Unauthorized',
          url: 'https://example.com/status',
          body: '',
          bodyTruncated: false,
          headers: {},
        }),
      },
    })
    await executor(task, run, store)
    expect(store.getRun(run.id)?.status).toBe('succeeded')
  })

  it('refuses non-daily tasks', async () => {
    const store = new TaskStore()
    const dev = store.createDevelopmentalTask({
      type: 'developmental',
      userId: 'u1',
      name: 'dev',
      repoUrl: 'https://github.com/x/y',
      agentName: 'opencode',
    })
    const run = store.createRun(dev.id)!
    const executor = createDailyExecutor()
    await expect(executor(dev, run, store)).rejects.toThrow(/non-daily/)
  })
})

describe('launchExecution — retry loop', () => {
  it('retries a failing executor with exponential backoff up to maxAttempts', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'ssh')
    const run = store.createRun(task.id)!
    let attempts = 0
    const failing = vi.fn(async () => {
      attempts += 1
      throw new Error(`attempt ${attempts} failed`)
    })
    const delays: number[] = []
    const events: TaskRunEvent[] = []
    const bus = new TaskRunEventBus()
    bus.on((e) => events.push(e))
    launchExecution(task, run, store, failing, {
      maxAttempts: 3,
      baseBackoffMs: 10,
      delay: async (ms) => {
        delays.push(ms)
      },
      bus,
    })
    // Wait for all attempts to finish.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(failing).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([10, 20])
    expect(store.getTask(task.id)?.status).toBe('failed')
    expect(events.filter((e) => e.type === 'attempt-failed').length).toBe(3)
    expect(events.filter((e) => e.type === 'run-abandoned').length).toBe(1)
  })

  it('succeeds on the first attempt without retrying', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'ssh')
    const run = store.createRun(task.id)!
    const executor = vi.fn(async () => {
      /* immediate success */
    })
    const events: TaskRunEvent[] = []
    const bus = new TaskRunEventBus()
    bus.on((e) => events.push(e))
    launchExecution(task, run, store, executor, {
      maxAttempts: 3,
      baseBackoffMs: 10,
      delay: async () => undefined,
      bus,
    })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(executor).toHaveBeenCalledTimes(1)
    expect(events.find((e) => e.type === 'attempt-succeeded')).toBeTruthy()
    expect(events.find((e) => e.type === 'run-abandoned')).toBeUndefined()
  })

  it('creates a fresh run per attempt so operators see each try', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'ssh')
    const firstRun = store.createRun(task.id)!
    const executor = vi.fn(async () => {
      throw new Error('always fail')
    })
    launchExecution(task, firstRun, store, executor, {
      maxAttempts: 3,
      baseBackoffMs: 1,
      delay: async () => undefined,
    })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const runs = store.listRunsForTask(task.id)
    expect(runs.length).toBe(3)
    expect(runs.every((r) => r.status === 'failed')).toBe(true)
  })

  it('clamps maxAttempts to a safe upper bound', async () => {
    const store = new TaskStore()
    const task = seedDailyTask(store, 'ssh')
    const run = store.createRun(task.id)!
    const executor = vi.fn(async () => {
      throw new Error('boom')
    })
    launchExecution(task, run, store, executor, {
      maxAttempts: 9999,
      baseBackoffMs: 0,
      delay: async () => undefined,
    })
    // Give the event loop plenty of time to churn.
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
    expect(executor.mock.calls.length).toBeLessThanOrEqual(10)
  })
})
