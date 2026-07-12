import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { router } from './routes.js'

const app = express()
const PORT = process.env.PORT || 3001

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true, // required for HTTP-only cookie auth
}))
app.use(express.json())
app.use(cookieParser())

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api', router)

// Health check (public — no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── Server startup ────────────────────────────────────────────────────────────
// Skip listen() in test environment so supertest can bind its own port.

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

export { app }
