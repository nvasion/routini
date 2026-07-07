import { Router, Request, Response } from 'express'

export const router = Router()

interface Item {
  id: number
  name: string
  createdAt: string
}

// In-memory storage for demo
const items: Item[] = [
  { id: 1, name: 'First Item', createdAt: new Date().toISOString() },
  { id: 2, name: 'Second Item', createdAt: new Date().toISOString() },
]

// Get all items
router.get('/items', (_req: Request, res: Response) => {
  res.json({ items, count: items.length })
})

// Get single item
router.get('/items/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10)
  const item = items.find(i => i.id === id)

  if (!item) {
    res.status(404).json({ error: 'Item not found' })
    return
  }

  res.json(item)
})

// Create item
router.post('/items', (req: Request, res: Response) => {
  const { name } = req.body

  if (!name) {
    res.status(400).json({ error: 'Name is required' })
    return
  }

  const newItem: Item = {
    id: items.length + 1,
    name,
    createdAt: new Date().toISOString(),
  }

  items.push(newItem)
  res.status(201).json(newItem)
})

// Delete item
router.delete('/items/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10)
  const index = items.findIndex(i => i.id === id)

  if (index === -1) {
    res.status(404).json({ error: 'Item not found' })
    return
  }

  items.splice(index, 1)
  res.json({ message: 'Item deleted', id })
})

// Version endpoint
router.get('/version', (_req: Request, res: Response) => {
  res.json({ version: '0.1.0', name: 'routini' })
})
