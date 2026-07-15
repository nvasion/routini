import { Router, Request, Response } from 'express'
import type { AISettings } from '../types.js'
import { requireCsrf } from './auth.js'

export const settingsRouter = Router()

// ── In-memory settings (skeleton – no persistence) ────────────────

export let currentSettings: AISettings = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  defaultAgentId: 'claude',
}

// ── GET /api/settings ─────────────────────────────────────────────

settingsRouter.get('/', (_req: Request, res: Response) => {
  // Never include secrets (API keys, tokens) in responses
  res.json(currentSettings)
})

// ── PUT /api/settings ─────────────────────────────────────────────

settingsRouter.put('/', requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  const { provider, model, defaultAgentId } = body

  if (provider !== undefined) {
    if (typeof provider !== 'string' || provider.trim() === '') {
      res.status(400).json({ error: 'provider must be a non-empty string' })
      return
    }
    currentSettings = { ...currentSettings, provider: provider.trim() }
  }

  if (model !== undefined) {
    if (typeof model !== 'string') {
      res.status(400).json({ error: 'model must be a string' })
      return
    }
    currentSettings = { ...currentSettings, model: model.trim() }
  }

  if (defaultAgentId !== undefined) {
    if (typeof defaultAgentId !== 'string') {
      res.status(400).json({ error: 'defaultAgentId must be a string' })
      return
    }
    currentSettings = { ...currentSettings, defaultAgentId: defaultAgentId.trim() }
  }

  res.json(currentSettings)
})
