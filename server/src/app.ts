import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { authRouter, requireAuth } from './routes/auth.js'
import { tasksRouter } from './routes/tasks.js'
import { settingsRouter } from './routes/settings.js'
import { notificationsRouter } from './routes/notifications.js'

export const app = express()

// ── CORS ──────────────────────────────────────────────────────────
// Restrict to the known frontend origin; credentials (cookies) require
// an explicit origin — wildcard '*' is not permitted with credentials.

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}))

// ── Body / cookie parsing ─────────────────────────────────────────
// COOKIE_SECRET signs cookies so tampering is detectable.  In dev/test
// the env var may be absent; production must set it explicitly.

app.use(express.json())
app.use(cookieParser(process.env.COOKIE_SECRET))

// ── General API rate limit ────────────────────────────────────────
// Auth routes carry their own stricter limiter (see routes/auth.ts).
// This limiter provides a backstop against request flooding on all /api
// paths. Skipped in test environments to avoid blocking integration tests.

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 200,                  // 200 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: () => process.env['NODE_ENV'] === 'test',
})

app.use('/api', apiLimiter)

// ── API routes ────────────────────────────────────────────────────
// Public: auth endpoints (login/logout/me)
app.use('/api/auth', authRouter)

// Protected: all task and settings endpoints require a valid Bearer token.
// Defense-in-depth: auth is enforced at the mount point rather than relying
// solely on individual handler checks.
app.use('/api/tasks', requireAuth, tasksRouter)
app.use('/api/settings', requireAuth, settingsRouter)
app.use('/api/notifications', requireAuth, notificationsRouter)

// ── Health check (public) ─────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── 404 handler ───────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' })
})

// ── Global error handler ──────────────────────────────────────────
// Logs details server-side; returns a generic message to clients to
// prevent leaking stack traces or implementation details.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err.message)
  res.status(500).json({ error: 'Internal server error' })
})
