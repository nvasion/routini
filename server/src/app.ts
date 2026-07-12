import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { router } from './routes.js'

export const app = express()

// ── Middleware ────────────────────────────────────────────────────
app.use(cors())
app.use(express.json())

// ── Routes ────────────────────────────────────────────────────────
app.use('/api', router)

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── 404 handler ───────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' })
})

// ── Global error handler ─────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err.message)
  res.status(500).json({ error: 'Internal server error' })
})
