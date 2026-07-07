import { useState, useEffect } from 'react'
import './App.css'

interface Item {
  id: number
  name: string
  createdAt: string
}

function App() {
  const [items, setItems] = useState<Item[]>([])
  const [newItemName, setNewItemName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchItems()
  }, [])

  const fetchItems = async () => {
    try {
      const response = await fetch('/api/items')
      const data = await response.json()
      setItems(data.items)
      setLoading(false)
    } catch (err) {
      setError('Failed to fetch items')
      setLoading(false)
    }
  }

  const addItem = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newItemName.trim()) return

    try {
      const response = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newItemName }),
      })
      const newItem = await response.json()
      setItems([...items, newItem])
      setNewItemName('')
    } catch (err) {
      setError('Failed to add item')
    }
  }

  const deleteItem = async (id: number) => {
    try {
      await fetch(`/api/items/${id}`, { method: 'DELETE' })
      setItems(items.filter(item => item.id !== id))
    } catch (err) {
      setError('Failed to delete item')
    }
  }

  if (loading) return <div className="app"><p>Loading...</p></div>

  return (
    <div className="app">
      <header className="header">
        <h1>routini</h1>
        <p>A full-stack TypeScript application</p>
      </header>

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

        <ul className="list">
          {items.map(item => (
            <li key={item.id} className="list-item">
              <span>{item.name}</span>
              <button onClick={() => deleteItem(item.id)} className="delete-btn">
                Delete
              </button>
            </li>
          ))}
        </ul>

        {items.length === 0 && <p className="empty">No items yet. Add one above!</p>}
      </main>
    </div>
  )
}

export default App
