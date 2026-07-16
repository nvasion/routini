import { Router, Request, Response } from 'express'
import type { AISettings } from '../types.js'
import { requireCsrf } from './auth.js'

export const settingsRouter = Router()

// ── In-memory settings (skeleton – no persistence) ────────────────

export let currentSettings: AISettings = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  defaultAgentId: 'claude',
  hasApiKey: false,
}

/**
 * API key stored separately so it is never accidentally serialised
 * into the settings response.  Production deployments should encrypt
 * this value at rest (e.g. using the KMS or vault secret store).
 *
 * Exported so tests can reset state between runs; never exposed via
 * the HTTP API.
 */
export let storedApiKey: string | null = null

// ── GET /api/settings ─────────────────────────────────────────────

settingsRouter.get('/', (_req: Request, res: Response) => {
  // Never include secrets (API keys, tokens) in responses.
  res.json(currentSettings)
})

// ── PUT /api/settings ─────────────────────────────────────────────

settingsRouter.put('/', requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  const { provider, model, defaultAgentId, apiKey } = body

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

  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      res.status(400).json({ error: 'apiKey must be a non-empty string' })
      return
    }
    // Store the key separately; never include it in currentSettings so it
    // cannot be accidentally serialised and returned in GET responses.
    storedApiKey = apiKey.trim()
    currentSettings = { ...currentSettings, hasApiKey: true }
  }

  res.json(currentSettings)
})
