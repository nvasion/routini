/**
 * Tests for TaskNotifier — the event bus subscriber that translates task
 * status transitions into email notifications.
 *
 * Strategy:
 *  - Use an InProcessTaskRunEventBus so we can emit events synchronously
 *    in tests without requiring a real transport.
 *  - Stub the Notifier so we can assert on the messages it receives without
 *    hitting a real SMTP server or SendGrid.
 *  - Check recipient resolution (username-as-email vs defaultToEmail vs skip).
 *  - Check that delivery failures are swallowed and logged (never thrown).
 *  - Check that unsubscribe actually stops further notifications.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InProcessTaskRunEventBus } from '../server/src/tasks/events.js'
import { TaskStore } from '../server/src/tasks/store.js'
import { UserStore } from '../server/src/auth/userStore.js'
import { TaskNotifier } from '../server/src/notifications/taskNotifier.js'
import type { Notifier, NotificationMessage } from '../server/src/notifications/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A stub Notifier that captures sent messages for assertions. */
function makeStubNotifier(): Notifier & {
  sent: NotificationMessage[]
  failNext: boolean
} {
  return {
    sent: [],
    failNext: false,
    async send(msg) {
      if (this.failNext) {
        this.failNext = false
        throw new Error('stub delivery failure')
      }
      this.sent.push(msg)
    },
  }
}

/** Helper: wait for all pending microtasks and setImmediate callbacks. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('TaskNotifier', () => {
  let bus: InProcessTaskRunEventBus
  let taskStore: TaskStore
  let userStore: UserStore
  let notifier: ReturnType<typeof makeStubNotifier>
  let taskNotifier: TaskNotifier

  beforeEach(() => {
    bus = new InProcessTaskRunEventBus()
    taskStore = new TaskStore({ bus })
    userStore = new UserStore()
    notifier = makeStubNotifier()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // start / unsubscribe
  // -------------------------------------------------------------------------

  it('subscribes to the bus on start() and returns an unsubscribe fn', () => {
    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    const countBefore = bus.listenerCount()
    const unsubscribe = taskNotifier.start(bus)
    expect(bus.listenerCount()).toBe(countBefore + 1)
    unsubscribe()
    expect(bus.listenerCount()).toBe(countBefore)
  })

  it('stops sending notifications after unsubscribe() is called', async () => {
    // Create a user with an email-looking username
    await userStore.createUser('user@example.com', 'pass1234')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1234')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'My Task',
      subtype: 'http',
      config: { url: 'http://example.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    const unsubscribe = taskNotifier.start(bus)

    // Unsubscribe immediately
    unsubscribe()

    // Emit a terminal status — should NOT trigger a notification
    taskStore.updateTaskStatus(task.id, 'succeeded')
    await flushAsync()

    expect(notifier.sent).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Recipient resolution
  // -------------------------------------------------------------------------

  it('sends to the user when username looks like an email address', async () => {
    await userStore.createUser('alice@example.com', 'Password1!')
    const user = await userStore.verifyCredentials('alice@example.com', 'Password1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'Nightly Backup',
      subtype: 'ssh',
      config: { host: 'h', username: 'u', command: 'ls' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'succeeded')
    await flushAsync()

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0].to).toBe('alice@example.com')
  })

  it('falls back to defaultToEmail when username is not an email', async () => {
    await userStore.createUser('alice', 'Password1!')
    const user = await userStore.verifyCredentials('alice', 'Password1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'Daily Check',
      subtype: 'http',
      config: { url: 'http://example.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore, {
      defaultToEmail: 'admin@routini.app',
    })
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'succeeded')
    await flushAsync()

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0].to).toBe('admin@routini.app')
  })

  it('skips notification when username is not an email and no defaultToEmail', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await userStore.createUser('alice', 'Password1!')
    const user = await userStore.verifyCredentials('alice', 'Password1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'Daily Check',
      subtype: 'http',
      config: { url: 'http://example.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'failed')
    await flushAsync()

    expect(notifier.sent).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(
      '[task-notifier] skipping notification: no recipient resolved',
      expect.objectContaining({ taskId: task.id, status: 'failed' }),
    )
  })

  // -------------------------------------------------------------------------
  // Status filtering
  // -------------------------------------------------------------------------

  it('sends notification when task transitions to succeeded', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'My Task',
      subtype: 'http',
      config: { url: 'http://x.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'succeeded')
    await flushAsync()

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0].subject).toContain('succeeded')
    expect(notifier.sent[0].subject).toContain('My Task')
  })

  it('sends notification when task transitions to failed', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'Broken Task',
      subtype: 'ssh',
      config: { host: 'h', username: 'u', command: 'ls' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'failed')
    await flushAsync()

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0].subject).toContain('failed')
    expect(notifier.sent[0].subject).toContain('Broken Task')
  })

  it('does NOT send notification for queued status', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'T',
      subtype: 'http',
      config: { url: 'http://x.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'queued')
    await flushAsync()

    expect(notifier.sent).toHaveLength(0)
  })

  it('does NOT send notification for running status', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'T',
      subtype: 'http',
      config: { url: 'http://x.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'running')
    await flushAsync()

    expect(notifier.sent).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // No duplicate notifications on repeated same-status transitions
  // -------------------------------------------------------------------------

  it('sends a notification for each terminal status emission', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'T',
      subtype: 'http',
      config: { url: 'http://x.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    // Two separate run cycles
    taskStore.updateTaskStatus(task.id, 'succeeded')
    taskStore.updateTaskStatus(task.id, 'idle')
    taskStore.updateTaskStatus(task.id, 'succeeded')
    await flushAsync()

    // The store only emits task-status events when the status *changes*, so
    // idle → succeeded transitions each trigger one notification.
    expect(notifier.sent).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // Delivery failures are swallowed
  // -------------------------------------------------------------------------

  it('logs an error but does not throw when notifier.send() rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'T',
      subtype: 'http',
      config: { url: 'http://x.com' },
    })

    notifier.failNext = true
    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    // Should NOT throw — errors are caught inside the notifier
    expect(() => {
      taskStore.updateTaskStatus(task.id, 'succeeded')
    }).not.toThrow()

    await flushAsync()

    expect(errorSpy).toHaveBeenCalledWith(
      '[task-notifier] failed to send notification',
      expect.objectContaining({ taskId: task.id, status: 'succeeded' }),
    )
    // Recipient address must not appear in the log entry
    const calls = errorSpy.mock.calls
    const lastCall = calls[calls.length - 1]
    expect(JSON.stringify(lastCall)).not.toContain('user@example.com')
  })

  // -------------------------------------------------------------------------
  // Deleted task mid-flight
  // -------------------------------------------------------------------------

  it('skips notification silently when the task was deleted before the event fires', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'T',
      subtype: 'http',
      config: { url: 'http://x.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    // Delete the task before the event handler runs
    taskStore.deleteTask(task.id)

    // Emit directly on the bus (simulates a race where the status event was
    // published just before the task was deleted and our handler sees it late)
    bus.emit({ type: 'task-status', taskId: task.id, status: 'succeeded' })
    await flushAsync()

    expect(notifier.sent).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Message content
  // -------------------------------------------------------------------------

  it('includes task name and task id in the notification body', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: 'Scheduled Report',
      subtype: 'http',
      config: { url: 'http://example.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'failed')
    await flushAsync()

    const msg = notifier.sent[0]
    expect(msg.text).toContain('Scheduled Report')
    expect(msg.text).toContain(task.id)
    expect(msg.html).toContain('Scheduled Report')
    expect(msg.html).toContain(task.id)
  })

  it('escapes HTML special characters in task name', async () => {
    await userStore.createUser('user@example.com', 'pass1!')
    const user = await userStore.verifyCredentials('user@example.com', 'pass1!')
    const task = taskStore.createDailyTask({
      type: 'daily',
      userId: user!.id,
      name: '<script>alert("xss")</script>',
      subtype: 'http',
      config: { url: 'http://example.com' },
    })

    taskNotifier = new TaskNotifier(notifier, taskStore, userStore)
    taskNotifier.start(bus)

    taskStore.updateTaskStatus(task.id, 'succeeded')
    await flushAsync()

    const msg = notifier.sent[0]
    // The raw script tag must not appear verbatim in the HTML body
    expect(msg.html).not.toContain('<script>')
    expect(msg.html).toContain('&lt;script&gt;')
  })
})
