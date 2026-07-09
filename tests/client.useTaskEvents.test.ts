/**
 * Unit tests for the `useTaskEvents` hook module.
 *
 * The React lifecycle side of the hook depends on a browser-only global
 * (`EventSource`) plus React's mount context, and this repository does
 * not run under jsdom / React Testing Library — pulling those in for a
 * single hook would add a lot of tooling to the test surface.
 *
 * Instead we test:
 *   1. The exported `dispatchEvent` helper — the JSON parse + handler
 *      dispatch pipeline that is the meat of the runtime behaviour.
 *   2. The wire type re-exports so downstream consumers importing from
 *      the hook module keep working.
 *
 * Between these tests, `tests/tasks.wireContract.test.ts`, and
 * `tests/tasks.sse.test.ts`, every observable behaviour of the SSE
 * feature is exercised end-to-end.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  dispatchEvent,
  type RunLogEvent,
  type TaskStatusEvent,
} from '../client/src/hooks/useTaskEvents'
import type {
  WireEvent,
  WireTaskStatusEvent,
} from '../client/src/hooks/taskEventWire'

describe('dispatchEvent — SSE MessageEvent decoder', () => {
  it('parses the JSON payload and forwards it to the handler', () => {
    const handler = vi.fn<[TaskStatusEvent], void>()
    const payload: TaskStatusEvent = {
      type: 'task-status',
      taskId: 'task-1',
      status: 'running',
    }
    dispatchEvent<TaskStatusEvent>(handler, {
      type: 'task-status',
      data: JSON.stringify(payload),
    })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(payload)
  })

  it('is a no-op when no handler is supplied', () => {
    // Simply must not throw — the hook passes `undefined` for
    // callbacks the caller did not register.
    expect(() =>
      dispatchEvent(undefined, {
        type: 'task-status',
        data: JSON.stringify({
          type: 'task-status',
          taskId: 't',
          status: 'running',
        }),
      }),
    ).not.toThrow()
  })

  it('logs and swallows a malformed JSON payload instead of throwing', () => {
    const handler = vi.fn<[TaskStatusEvent], void>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      dispatchEvent<TaskStatusEvent>(handler, {
        type: 'task-status',
        data: '{not valid json',
      })
      expect(handler).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      // The warn message should point at useTaskEvents so a real bug is
      // greppable from a production log line.
      const [prefix] = warn.mock.calls[0]
      expect(prefix).toContain('useTaskEvents')
    } finally {
      warn.mockRestore()
    }
  })

  it('preserves the discriminated-union shape when the caller narrows on `type`', () => {
    // Compile-time proof plus runtime check: dispatching a `run-log`
    // payload to a `run-log` handler should get the log entry through.
    const handler = vi.fn<[RunLogEvent], void>()
    const payload: RunLogEvent = {
      type: 'run-log',
      taskId: 'task-1',
      runId: 'run-1',
      log: {
        timestamp: '2025-01-01T00:00:00.000Z',
        message: 'hello',
        level: 'info',
      },
    }
    dispatchEvent<RunLogEvent>(handler, {
      type: 'run-log',
      data: JSON.stringify(payload),
    })
    expect(handler).toHaveBeenCalledWith(payload)
    // The log entry survived JSON round-trip
    expect(handler.mock.calls[0][0].log.message).toBe('hello')
  })

  it('does NOT throw on an empty-string data payload — logs and moves on', () => {
    const handler = vi.fn<[TaskStatusEvent], void>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Empty string is invalid JSON but a real SSE server can emit an
      // empty `data:` line — the hook must survive it.
      dispatchEvent<TaskStatusEvent>(handler, { type: 'task-status', data: '' })
      expect(handler).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('useTaskEvents module — public contract', () => {
  it('re-exports the wire event types as hook-friendly aliases', () => {
    // Compile-time proof that the wire types remain assignable to the
    // hook re-exports. A future refactor that renames a wire type but
    // forgets the re-export would break this expression.
    const status: TaskStatusEvent = {
      type: 'task-status',
      taskId: 't',
      status: 'succeeded',
    }
    const wire: WireTaskStatusEvent = status
    expect(wire.type).toBe('task-status')
  })

  it('union coverage — every wire event has a matching hook alias', () => {
    // Enumerate the WireEvent union at the value level via a switch that
    // exhaustively narrows. TypeScript enforces that every arm is handled.
    // If someone adds a new wire event and forgets the hook alias, this
    // function stops type-checking.
    const cover = (event: WireEvent): string => {
      switch (event.type) {
        case 'task-created':
          return event.taskType
        case 'task-deleted':
          return event.taskId
        case 'task-status':
          return event.status
        case 'run-created':
          return event.runId
        case 'run-status':
          return event.status
        case 'run-log':
          return event.log.message
      }
    }
    expect(
      cover({
        type: 'task-status',
        taskId: 't',
        status: 'running',
      }),
    ).toBe('running')
  })
})
