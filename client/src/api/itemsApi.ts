/**
 * Items API client.
 *
 * Provides typed wrappers for the /api/items endpoints so page components
 * stay focused on rendering. All requests include `credentials: 'include'`
 * so the HttpOnly auth cookie is sent automatically.
 *
 * The response parsers below enforce the runtime shape contract for API
 * responses. TypeScript casts (`as Item`) are compile-time only — they provide
 * zero runtime protection. If the server returns a malformed body (missing
 * fields, wrong types, a proxy HTML page, or an unexpected 2xx error body),
 * a bare cast silently sets component state to `undefined`. A subsequent
 * `items.map(…)` call then crashes with a TypeError because `undefined` has no
 * `.map` method. The parsers here turn that silent corruption into an explicit
 * thrown Error that the caller's try/catch can surface to the user.
 *
 * Exported parsers are unit-testable in isolation (no DOM, no React lifecycle).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Item {
  id: number
  name: string
  createdAt: string
}

interface ItemsResponse {
  items: Item[]
  count: number
}

// ---------------------------------------------------------------------------
// Base fetch helper
// ---------------------------------------------------------------------------

async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { credentials: 'include', ...init })
}

// ---------------------------------------------------------------------------
// Response parsers — runtime shape validation
//
// `isValidItem` is a shared type guard used by both `parseItemResponse` and
// (for future per-element validation) by `parseItemsResponse`. Extracting it
// as a single helper ensures that if the `Item` interface changes, the
// validation logic is updated in exactly one place (DRY).
// ---------------------------------------------------------------------------

/**
 * Type guard that asserts a value has the `Item` shape at runtime.
 * Extracted as a shared helper so both parsers stay consistent.
 */
function isValidItem(data: unknown): data is Item {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { id?: unknown }).id === 'number' &&
    typeof (data as { name?: unknown }).name === 'string' &&
    typeof (data as { createdAt?: unknown }).createdAt === 'string'
  )
}

/**
 * Validate that a parsed API response body is an `ItemsResponse`.
 *
 * Turns a malformed or unexpected GET /api/items response into a thrown Error
 * (caught by the caller's catch block) instead of silently leaving `items`
 * state as `undefined` and crashing the `.map()` render.
 *
 * Validates both the envelope shape (items must be an array) and each element
 * within the array (every item must match the Item interface). Using `as Item`
 * would be compile-time-only; element validation here prevents malformed
 * objects — including `null` array entries — from reaching the `.map()` call
 * and throwing a `TypeError` at render time.
 *
 * Exported for unit-testing in isolation without a DOM.
 */
export function parseItemsResponse(data: unknown): Item[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { items?: unknown }).items)
  ) {
    throw new Error('Unexpected server response: "items" is missing or not an array')
  }
  const arr = (data as { items: unknown[] }).items
  if (!arr.every(isValidItem)) {
    throw new Error(
      'Unexpected server response: one or more items have an invalid shape',
    )
  }
  return arr
}

/**
 * Validate that a parsed API response body is a single `Item`.
 *
 * The POST /api/items endpoint returns the newly-created item directly (not
 * wrapped in an object). Using `as Item` is a compile-time-only cast — if the
 * server shape ever changes, or a proxy injects an error body, the cast
 * silently produces a malformed object that gets pushed into the `items` array
 * and crashes the render. This function rejects any unexpected shape up-front.
 *
 * Exported for unit-testing in isolation without a DOM.
 */
export function parseItemResponse(data: unknown): Item {
  if (!isValidItem(data)) {
    throw new Error(
      'Unexpected server response: item is missing or has an invalid shape',
    )
  }
  return data
}

// ---------------------------------------------------------------------------
// Items endpoints
// ---------------------------------------------------------------------------

/**
 * Fetch all items for the authenticated user.
 * Throws an Error on non-2xx responses or malformed response bodies.
 */
export async function listItems(): Promise<Item[]> {
  const res = await apiFetch('/api/items')
  if (!res.ok) throw new Error(`Failed to fetch items (${res.status})`)
  return parseItemsResponse(await res.json())
}

/**
 * Create a new item and return the server-assigned record.
 * Throws an Error on non-2xx responses or malformed response bodies.
 */
export async function createItem(name: string): Promise<Item> {
  const res = await apiFetch('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`Failed to add item (${res.status})`)
  return parseItemResponse(await res.json())
}

/**
 * Delete an item by ID.
 * Throws an Error on non-2xx responses.
 */
export async function deleteItem(id: number): Promise<void> {
  const res = await apiFetch(`/api/items/${id}`, {
    method: 'DELETE',
    // Content-Type: application/json satisfies the server's CSRF middleware
    // even for bodyless DELETE requests.
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Failed to delete item (${res.status})`)
}
