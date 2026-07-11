import { useEffect, useState, type FormEvent } from 'react'

interface Item {
  id: number
  name: string
  createdAt: string
}

interface ItemsResponse {
  items: Item[]
  count: number
}

async function apiFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { credentials: 'include', ...init })
}

/**
 * Validate that a parsed API response body is an `ItemsResponse`.
 *
 * TypeScript casts (`as ItemsResponse`) are compile-time only — they do
 * nothing at runtime. This function enforces the shape at runtime so that a
 * malformed or unexpected server response is turned into a thrown `Error`
 * (caught by the fetch effect's `catch` block) instead of silently leaving
 * `items` state as `undefined` and crashing the `.map()` render.
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
  return (data as ItemsResponse).items
}

export function Dashboard() {
  const [items, setItems] = useState<Item[]>([])
  const [newItemName, setNewItemName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await apiFetch('/api/items')
        if (!response.ok) {
          throw new Error(`Failed to fetch items (${response.status})`)
        }
        const items = parseItemsResponse(await response.json())
        if (!cancelled) setItems(items)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch items')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const addItem = async (event: FormEvent) => {
    event.preventDefault()
    const name = newItemName.trim()
    if (!name) return
    try {
      const response = await apiFetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) {
        throw new Error(`Failed to add item (${response.status})`)
      }
      const created = (await response.json()) as Item
      setItems((prev) => [...prev, created])
      setNewItemName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item')
    }
  }

  const deleteItem = async (id: number) => {
    try {
      const response = await apiFetch(`/api/items/${id}`, {
        method: 'DELETE',
        // Content-Type: application/json satisfies the server's CSRF middleware
        // even for bodyless DELETE requests.
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) {
        throw new Error(`Failed to delete item (${response.status})`)
      }
      setItems((prev) => prev.filter((item) => item.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item')
    }
  }

  return (
    <main className="main">
      {error && <p className="error">{error}</p>}

      <form onSubmit={addItem} className="form">
        <input
          type="text"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          placeholder="Enter item name"
          className="input"
        />
        <button type="submit" className="button">Add Item</button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p className="empty">No items yet. Add one above!</p>
      ) : (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id} className="list-item">
              <span>{item.name}</span>
              <button
                onClick={() => deleteItem(item.id)}
                className="delete-btn"
                type="button"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
