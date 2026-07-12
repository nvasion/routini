/**
 * Unit tests for the `parseTasksResponse` and `parseRunsResponse` helpers
 * exported from the tasks API client module.
 *
 * WHY THIS EXISTS
 * ───────────────
 * TypeScript casts (`as { tasks: Task[] }`) are erased at compile time and
 * provide zero runtime protection.  If the server returns a body whose shape
 * does not match what the client expects — e.g. `{ error: "Unauthorised" }`
 * slipping through a 2xx proxy, a HTML login-redirect page, or a future API
 * schema change — `data.tasks` silently evaluates to `undefined`.  Any
 * subsequent `.map()` / `.filter()` on that undefined value throws an
 * uncaught TypeError that crashes the React component tree.
 *
 * `parseTasksResponse` and `parseRunsResponse` are the single places where
 * the runtime shape contract is enforced.  These tests cover every failure
 * mode that leads to the original crash so regressions are caught before
 * they reach the browser.
 *
 * The tests run in the shared Node.js vitest environment alongside the server
 * tests — no JSDOM / React lifecycle needed because the two functions are
 * pure validators with no DOM dependencies.
 */

import { describe, expect, it } from 'vitest'
import { TasksApiError, parseRunsResponse, parseTasksResponse } from '../client/src/tasks/tasksApi'

// ---------------------------------------------------------------------------
// parseTasksResponse — valid responses
// ---------------------------------------------------------------------------

describe('parseTasksResponse — valid responses', () => {
  it('returns the tasks array from a well-formed response', () => {
    const task = {
      id: 'task-1',
      userId: 'user-1',
      name: 'My task',
      type: 'daily',
      subtype: 'dns',
      status: 'idle',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const result = parseTasksResponse({ tasks: [task], count: 1 })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-1')
  })

  it('returns an empty array when tasks is []', () => {
    const result = parseTasksResponse({ tasks: [] })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it('ignores extra keys in the response (forward-compat)', () => {
    const input = { tasks: [{ id: 't', name: 'x', type: 'daily' }], meta: 'extra', total: 99 }
    expect(() => parseTasksResponse(input)).not.toThrow()
    expect(parseTasksResponse(input)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// parseTasksResponse — malformed / unexpected responses
// ---------------------------------------------------------------------------

describe('parseTasksResponse — malformed / unexpected responses', () => {
  it('throws TasksApiError when the response is null', () => {
    expect(() => parseTasksResponse(null)).toThrow(TasksApiError)
    expect(() => parseTasksResponse(null)).toThrow(/tasks.*missing|not an array/i)
  })

  it('throws TasksApiError when the response is undefined', () => {
    expect(() => parseTasksResponse(undefined)).toThrow(TasksApiError)
    expect(() => parseTasksResponse(undefined)).toThrow(/tasks.*missing|not an array/i)
  })

  it('throws when the response is a plain string (e.g. proxy HTML page)', () => {
    expect(() => parseTasksResponse('<!DOCTYPE html>')).toThrow(TasksApiError)
  })

  it('throws when the response is a number', () => {
    expect(() => parseTasksResponse(42)).toThrow(TasksApiError)
  })

  it('throws when tasks field is absent — { error: "Unauthorised" }', () => {
    // Exact shape an auth-error proxy might return with a 2xx status code
    expect(() => parseTasksResponse({ error: 'Unauthorised' })).toThrow(TasksApiError)
    expect(() => parseTasksResponse({ error: 'Unauthorised' })).toThrow(
      /tasks.*missing|not an array/i,
    )
  })

  it('throws when tasks is null', () => {
    expect(() => parseTasksResponse({ tasks: null })).toThrow(TasksApiError)
  })

  it('throws when tasks is undefined (key present, value missing)', () => {
    expect(() => parseTasksResponse({ tasks: undefined })).toThrow(TasksApiError)
  })

  it('throws when tasks is a plain object (not an array)', () => {
    expect(() => parseTasksResponse({ tasks: {} })).toThrow(TasksApiError)
  })

  it('throws when tasks is a number', () => {
    expect(() => parseTasksResponse({ tasks: 42 })).toThrow(TasksApiError)
  })

  it('throws when tasks is a string', () => {
    expect(() => parseTasksResponse({ tasks: 'surprise' })).toThrow(TasksApiError)
  })

  it('throws when tasks is a boolean', () => {
    expect(() => parseTasksResponse({ tasks: true })).toThrow(TasksApiError)
  })
})

// ---------------------------------------------------------------------------
// parseRunsResponse — valid responses
// ---------------------------------------------------------------------------

describe('parseRunsResponse — valid responses', () => {
  it('returns the runs array from a well-formed response', () => {
    const run = {
      id: 'run-1',
      taskId: 'task-1',
      status: 'succeeded',
      startedAt: '2025-01-01T00:00:00.000Z',
      logs: [],
    }
    const result = parseRunsResponse({ runs: [run] })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('run-1')
  })

  it('returns an empty array when runs is []', () => {
    const result = parseRunsResponse({ runs: [] })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it('ignores extra keys in the response (forward-compat)', () => {
    const input = { runs: [{ id: 'r', taskId: 't', status: 'succeeded' }], count: 1 }
    expect(() => parseRunsResponse(input)).not.toThrow()
    expect(parseRunsResponse(input)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// parseRunsResponse — malformed / unexpected responses
// ---------------------------------------------------------------------------

describe('parseRunsResponse — malformed / unexpected responses', () => {
  it('throws TasksApiError when the response is null', () => {
    expect(() => parseRunsResponse(null)).toThrow(TasksApiError)
    expect(() => parseRunsResponse(null)).toThrow(/runs.*missing|not an array/i)
  })

  it('throws TasksApiError when the response is undefined', () => {
    expect(() => parseRunsResponse(undefined)).toThrow(TasksApiError)
    expect(() => parseRunsResponse(undefined)).toThrow(/runs.*missing|not an array/i)
  })

  it('throws when the response is a plain string', () => {
    expect(() => parseRunsResponse('<!DOCTYPE html>')).toThrow(TasksApiError)
  })

  it('throws when the response is a number', () => {
    expect(() => parseRunsResponse(42)).toThrow(TasksApiError)
  })

  it('throws when runs field is absent — { error: "Not Found" }', () => {
    expect(() => parseRunsResponse({ error: 'Not Found' })).toThrow(TasksApiError)
    expect(() => parseRunsResponse({ error: 'Not Found' })).toThrow(
      /runs.*missing|not an array/i,
    )
  })

  it('throws when runs is null', () => {
    expect(() => parseRunsResponse({ runs: null })).toThrow(TasksApiError)
  })

  it('throws when runs is undefined (key present, value missing)', () => {
    expect(() => parseRunsResponse({ runs: undefined })).toThrow(TasksApiError)
  })

  it('throws when runs is a plain object (not an array)', () => {
    expect(() => parseRunsResponse({ runs: {} })).toThrow(TasksApiError)
  })

  it('throws when runs is a number', () => {
    expect(() => parseRunsResponse({ runs: 42 })).toThrow(TasksApiError)
  })

  it('throws when runs is a string', () => {
    expect(() => parseRunsResponse({ runs: 'surprise' })).toThrow(TasksApiError)
  })

  it('throws when runs is a boolean', () => {
    expect(() => parseRunsResponse({ runs: false })).toThrow(TasksApiError)
  })
})
