/**
 * Unit tests for the `parseItemsResponse` helper exported from the Dashboard
 * component module.
 *
 * WHY THIS EXISTS
 * ───────────────
 * TypeScript casts (`as ItemsResponse`) are erased at compile time — they
 * provide zero runtime protection. If the server returns a body whose shape
 * does not match what the component expects (e.g. `{ error: "…" }` with an
 * unexpected 2xx, a proxy page, or a future API schema change), the `items`
 * state would be set to `undefined`. The next render then crashes on
 * `items.map(…)` because `undefined` has no `.map` method.
 *
 * `parseItemsResponse` is the single, isolated place where the runtime shape
 * contract is enforced. These tests cover the failure modes that triggered the
 * original crash so regressions are caught before they reach the browser.
 *
 * The tests run in the shared Node.js vitest environment alongside the server
 * tests — no JSDOM required because `parseItemsResponse` is a pure function
 * with no DOM or React lifecycle dependencies.
 */

import { describe, expect, it } from 'vitest'
import { parseItemsResponse } from '../client/src/pages/Dashboard'

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parseItemsResponse — valid responses', () => {
  it('returns the items array from a well-formed response', () => {
    const input = {
      items: [
        { id: 1, name: 'First Item', createdAt: '2025-01-01T00:00:00.000Z' },
        { id: 2, name: 'Second Item', createdAt: '2025-01-02T00:00:00.000Z' },
      ],
      count: 2,
    }
    const result = parseItemsResponse(input)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('First Item')
    expect(result[1].name).toBe('Second Item')
  })

  it('returns an empty array when items is []', () => {
    const input = { items: [], count: 0 }
    const result = parseItemsResponse(input)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it('ignores extra keys in the response (forward-compat)', () => {
    const input = { items: [{ id: 3, name: 'Extra', createdAt: '' }], count: 1, meta: 'ok' }
    expect(() => parseItemsResponse(input)).not.toThrow()
    expect(parseItemsResponse(input)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Error paths — these are the shapes that caused the original crash
// ---------------------------------------------------------------------------

describe('parseItemsResponse — malformed / unexpected responses', () => {
  it('throws when the response is null (JSON body "null")', () => {
    expect(() => parseItemsResponse(null)).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when the response is undefined', () => {
    expect(() => parseItemsResponse(undefined)).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when the response is a plain string (e.g. proxy HTML)', () => {
    expect(() => parseItemsResponse('<!DOCTYPE html>')).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when the response is a number', () => {
    expect(() => parseItemsResponse(42)).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when items field is absent ({ error: "Unauthorized" })', () => {
    // This is the exact shape a 2xx error-proxy body might send
    expect(() => parseItemsResponse({ error: 'Unauthorized' })).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when items is null', () => {
    expect(() => parseItemsResponse({ items: null, count: 0 })).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when items is undefined (key present but value missing)', () => {
    expect(() => parseItemsResponse({ items: undefined, count: 0 })).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when items is an object (not an array)', () => {
    // {} has .length === undefined which is falsy — previously slipped
    // past `items.length === 0` into `items.map(…)` and crashed
    expect(() => parseItemsResponse({ items: {}, count: 0 })).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when items is a number', () => {
    expect(() => parseItemsResponse({ items: 42, count: 1 })).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when items is a string', () => {
    expect(() => parseItemsResponse({ items: 'surprise', count: 1 })).toThrow(
      /items.*missing|not an array/i,
    )
  })

  it('throws when items is a boolean', () => {
    expect(() => parseItemsResponse({ items: true, count: 0 })).toThrow(
      /items.*missing|not an array/i,
    )
  })
})
