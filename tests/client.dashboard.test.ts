/**
 * Unit tests for the `parseItemsResponse` and `parseItemResponse` helpers
 * exported from the items API client module.
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
 * `parseItemsResponse` and `parseItemResponse` are the single, isolated places
 * where the runtime shape contract is enforced. These tests cover the failure
 * modes that triggered the original crash so regressions are caught before
 * they reach the browser.
 *
 * The tests run in the shared Node.js vitest environment alongside the server
 * tests — no JSDOM required because the parsers are pure functions with no DOM
 * or React lifecycle dependencies.
 */

import { describe, expect, it } from 'vitest'
import { parseItemResponse, parseItemsResponse } from '../client/src/api/itemsApi'

// ---------------------------------------------------------------------------
// parseItemsResponse — GET /api/items response validator
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

// ---------------------------------------------------------------------------
// parseItemResponse — single-item POST response validator
//
// The POST /api/items endpoint returns a bare Item object (not wrapped in a
// list). Using `as Item` provided zero runtime protection: any unexpected
// body shape would silently produce a malformed element in the `items` array.
// `parseItemResponse` enforces the shape at runtime so the error is caught
// and surfaced as a user-visible message rather than a downstream crash.
// ---------------------------------------------------------------------------

describe('parseItemResponse — valid responses', () => {
  const VALID: unknown = { id: 3, name: 'New Item', createdAt: '2025-06-01T00:00:00.000Z' }

  it('returns the item when the shape is correct', () => {
    const result = parseItemResponse(VALID)
    expect(result).toEqual(VALID)
  })

  it('ignores extra keys (forward-compat)', () => {
    const input = { id: 4, name: 'Extra', createdAt: '2025-01-01T00:00:00.000Z', extra: true }
    expect(() => parseItemResponse(input)).not.toThrow()
    const result = parseItemResponse(input)
    expect(result.id).toBe(4)
    expect(result.name).toBe('Extra')
  })
})

describe('parseItemResponse — malformed / unexpected responses', () => {
  it('throws when the response is null', () => {
    expect(() => parseItemResponse(null)).toThrow(/(item.*missing|invalid shape)/i)
  })

  it('throws when the response is undefined', () => {
    expect(() => parseItemResponse(undefined)).toThrow(/(item.*missing|invalid shape)/i)
  })

  it('throws when the response is a plain string (e.g. proxy HTML)', () => {
    expect(() => parseItemResponse('<!DOCTYPE html>')).toThrow(/(item.*missing|invalid shape)/i)
  })

  it('throws when the response is a number', () => {
    expect(() => parseItemResponse(42)).toThrow(/(item.*missing|invalid shape)/i)
  })

  it('throws when id is missing', () => {
    expect(() => parseItemResponse({ name: 'No id', createdAt: '2025-01-01T00:00:00.000Z' })).toThrow(
      /(item.*missing|invalid shape)/i,
    )
  })

  it('throws when id is a string instead of a number', () => {
    expect(() =>
      parseItemResponse({ id: '3', name: 'String id', createdAt: '2025-01-01T00:00:00.000Z' }),
    ).toThrow(/(item.*missing|invalid shape)/i)
  })

  it('throws when name is missing', () => {
    expect(() => parseItemResponse({ id: 1, createdAt: '2025-01-01T00:00:00.000Z' })).toThrow(
      /(item.*missing|invalid shape)/i,
    )
  })

  it('throws when name is a number instead of a string', () => {
    expect(() =>
      parseItemResponse({ id: 1, name: 99, createdAt: '2025-01-01T00:00:00.000Z' }),
    ).toThrow(/(item.*missing|invalid shape)/i)
  })

  it('throws when createdAt is missing', () => {
    expect(() => parseItemResponse({ id: 1, name: 'No date' })).toThrow(
      /(item.*missing|invalid shape)/i,
    )
  })

  it('throws when createdAt is a number instead of a string', () => {
    expect(() => parseItemResponse({ id: 1, name: 'Bad date', createdAt: 123456789 })).toThrow(
      /(item.*missing|invalid shape)/i,
    )
  })

  it('throws on an error-envelope body ({ error: "..." }) — the pre-fix crash trigger', () => {
    // This is the exact shape a server-side error or proxy might return even on 2xx.
    // Before the fix, `as Item` would silently accept it and the malformed object
    // would be pushed into the items array, causing crashes at render time.
    expect(() => parseItemResponse({ error: 'Internal Server Error' })).toThrow(
      /(item.*missing|invalid shape)/i,
    )
  })

  it('throws on an items-list envelope ({ items: [...] }) — wrong endpoint shape', () => {
    // Would happen if the POST endpoint accidentally returned the list shape.
    // `as Item` would silently accept it, producing an object with no id/name,
    // which would crash or silently corrupt the items list.
    expect(() =>
      parseItemResponse({ items: [{ id: 1, name: 'x', createdAt: '' }], count: 1 }),
    ).toThrow(/(item.*missing|invalid shape)/i)
  })
})
