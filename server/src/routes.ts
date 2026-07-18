import { Router, Request, Response } from 'express'
import { authRouter, requireAuth, requireCsrf } from './routes/auth.js'

// Then mount the auth router:
router.use('/auth', authRouter)

export const router = Router()

// ── Auth routes (public) ──────────────────────────────────────────────────────

router.post('/auth/login', loginHandler)
router.post('/auth/logout', logoutHandler)
router.get('/auth/me', requireAuth, meHandler)

// ── Item types & storage ──────────────────────────────────────────────────────

interface Item {
  id: number
  name: string
  createdAt: string
}

// In-memory storage for demo — replace with a database in production
const items: Item[] = [
  { id: 1, name: 'First Item', createdAt: new Date().toISOString() },
  { id: 2, name: 'Second Item', createdAt: new Date().toISOString() },
]

// ── Item routes (protected) ───────────────────────────────────────────────────

// Get all items
router.get('/items', requireAuth, (_req: Request, res: Response) => {
  res.json({ items, count: items.length })
})

// Get single item
router.get('/items/:id', requireAuth, (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid item id' })
    return
  }
  const item = items.find(i => i.id === id)
  if (!item) {
    res.status(404).json({ error: 'Item not found' })
    return
  }
  res.json(item)
})

// Create item — requireCsrf guards against cross-site state mutation
router.post('/items', requireAuth, requireCsrf, (req: Request, res: Response) => {
  const { name } = req.body
  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Name is required' })
    return
  }

  const newItem: Item = {
    id: items.length > 0 ? Math.max(...items.map(i => i.id)) + 1 : 1,
    name: name.trim(),
    createdAt: new Date().toISOString(),
  }

  items.push(newItem)
  res.status(201).json(newItem)
})

// Delete item — requireCsrf guards against cross-site state mutation
router.delete('/items/:id', requireAuth, requireCsrf, (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid item id' })
    return
  }
  const index = items.findIndex(i => i.id === id)
  if (index === -1) {
    res.status(404).json({ error: 'Item not found' })
    return
  }

  items.splice(index, 1)
  res.json({ message: 'Item deleted', id })
})

// Version endpoint (public — useful for health checks and CI)
router.get('/version', (_req: Request, res: Response) => {
  res.json({ version: '0.1.0', name: 'routini' })
})
