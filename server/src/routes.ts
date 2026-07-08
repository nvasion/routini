import { Router, type Request, type Response } from 'express'
import { csrfProtect, requireAuth, type AuthDependencies } from './auth/index.js'

interface Item {
  id: number
  name: string
  createdAt: string
}

const MAX_ITEM_NAME_LENGTH = 200

/**
 * Build the main API router. The auth dependencies are injected so tests can
 * supply an isolated user store / config per suite.
 */
export function createRouter(deps: AuthDependencies): Router {
  const router = Router()

  // In-memory storage for demo purposes. Swap for a real store when needed.
  const items: Item[] = [
    { id: 1, name: 'First Item', createdAt: new Date().toISOString() },
    { id: 2, name: 'Second Item', createdAt: new Date().toISOString() },
  ]
  let nextId = items.length + 1

  // Version endpoint is public so unauthenticated clients can perform simple
  // feature/version checks (e.g. from the login page).
  router.get('/version', (_req: Request, res: Response) => {
    res.json({ version: '0.1.0', name: 'routini' })
  })

  // Everything else in this router requires an authenticated user.
  router.use(requireAuth(deps))

  // State-changing endpoints must be application/json — see csrfProtect for
  // the rationale. Reads (GET) are unaffected.
  const csrf = csrfProtect()

  router.get('/items', (_req: Request, res: Response) => {
    res.json({ items, count: items.length })
  })

  router.get('/items/:id', (req: Request, res: Response) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const item = items.find((i) => i.id === id)
    if (!item) {
      res.status(404).json({ error: 'Item not found' })
      return
    }
    res.json(item)
  })

  router.post('/items', csrf, (req: Request, res: Response) => {
    const { name } = (req.body ?? {}) as { name?: unknown }
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Name is required' })
      return
    }
    if (name.length > MAX_ITEM_NAME_LENGTH) {
      res.status(400).json({ error: 'Name is too long' })
      return
    }

    const newItem: Item = {
      id: nextId++,
      name: name.trim(),
      createdAt: new Date().toISOString(),
    }
    items.push(newItem)
    res.status(201).json(newItem)
  })

  router.delete('/items/:id', csrf, (req: Request, res: Response) => {
    const id = Number.parseInt(req.params.id, 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const index = items.findIndex((i) => i.id === id)
    if (index === -1) {
      res.status(404).json({ error: 'Item not found' })
      return
    }
    items.splice(index, 1)
    res.json({ message: 'Item deleted', id })
  })

  return router
}
