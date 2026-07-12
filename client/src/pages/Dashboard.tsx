import { useEffect, useState, type FormEvent } from 'react'
import { type Item, listItems, createItem, deleteItem } from '../api/itemsApi'

export function Dashboard() {
  // Initialized to an empty array so `items` is never `undefined`.
  // listItems() validates the API response shape before calling setItems(),
  // so the array always contains well-formed Item objects.
  const [items, setItems] = useState<Item[]>([])
  const [newItemName, setNewItemName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await listItems()
        if (!cancelled) setItems(data)
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
      const created = await createItem(name)
      setItems((prev) => [...prev, created])
      setNewItemName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item')
    }
  }

  const handleDeleteItem = async (id: number) => {
    try {
      await deleteItem(id)
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
          {items?.map((item) => (
            <li key={item.id} className="list-item">
              <span>{item.name}</span>
              <button
                onClick={() => handleDeleteItem(item.id)}
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
