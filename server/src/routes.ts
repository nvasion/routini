import { Router, Request, Response } from 'express'

export const router = Router()

interface Item {
  id: number
  name: string
  createdAt: string
}

// In-memory storage for the skeleton. A persistence layer will be introduced
// alongside the task-CRUD implementation task in the PRD.
const items: Item[] = [
  { id: 1, name: 'First Item', createdAt: new Date().toISOString() },
  { id: 2, name: 'Second Item', createdAt: new Date().toISOString() },
]
let nextId = items.length + 1

const MAX_NAME_LENGTH = 200

/** Parse a positive integer id from a route param, or return null if invalid. */
function parseId(raw: string): number | null {
  // `Number` rejects trailing garbage (unlike `parseInt`) so `"1abc"` → NaN.
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Type guard for a non-empty, length-bounded string. */
function isValidName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_NAME_LENGTH
  )
}

function sendInvalidId(res: Response): void {
  res.status(400).json({ error: 'Invalid item id' })
}

function sendNotFound(res: Response): void {
  res.status(404).json({ error: 'Item not found' })
}

router.get('/items', (_req: Request, res: Response) => {
  res.json({ items, count: items.length })
})

router.get('/items/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    sendInvalidId(res)
    return
  }

  const item = items.find(i => i.id === id)
  if (!item) {
    sendNotFound(res)
    return
  }

  res.json(item)
})

router.post('/items', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { name } = body

  if (!isValidName(name)) {
    res.status(400).json({
      error: `Name must be a non-empty string (max ${MAX_NAME_LENGTH} characters)`,
    })
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

router.delete('/items/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    sendInvalidId(res)
    return
  }

  const index = items.findIndex(i => i.id === id)
  if (index === -1) {
    sendNotFound(res)
    return
  }

  items.splice(index, 1)
  res.json({ message: 'Item deleted', id })
})

router.get('/version', (_req: Request, res: Response) => {
  res.json({ version: '0.1.0', name: 'routini' })
})
