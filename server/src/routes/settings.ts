import { Router, Request, Response } from 'express'
import type { AISettings } from '../types.js'
import { requireCsrf } from './auth.js'
import {
  saveCredential,
  getCredentialSecret,
  removeCredential,
} from '../services/credentials.js'

export const settingsRouter = Router()

// ── Credential store integration ──────────────────────────────────
//
// The AI API key is persisted via the encrypted credential store service
// (server/src/services/credentials.ts, AES-256-GCM at rest) so it survives
// server restarts and is never stored in plaintext on disk.  The settings
// document (provider/model/defaultAgentId) remains in memory because it is
// non-secret configuration; only the API key — a secret — goes through the
// credential store.
//
// The API key is stored under the "system" scope (null userId) because the AI
// settings are a single global configuration shared by all authenticated
// users, mirroring the single global `currentSettings` object.
const API_KEY_CREDENTIAL_NAME = 'ai_api_key'

// ── In-memory settings ────────────────────────────────────────────

export let currentSettings: AISettings = {
  provider: 'claude',
  model: 'claude-opus-4-5',
  defaultAgentId: 'claude',
  hasApiKey: false,
}

/**
 * API key held in memory so it is never accidentally serialised into the
 * settings response.  The credential store is the source of truth for
 * persistence; this export mirrors the decrypted value for in-process
 * consumers and tests.
 *
 * Exported so tests can verify state between runs; never exposed via the
 * HTTP API.  On module load we hydrate it from the credential store (best
 * effort — a missing or unavailable store simply means no key is loaded).
 */
export let storedApiKey: string | null = null

// ── Hydrate from the credential store on load ─────────────────────
//
// Reading at import time lets a freshly started server report hasApiKey
// correctly for a key that was stored in a previous process.  Any failure
// (e.g. the DB module is unavailable during isolated development) is
// swallowed so the server still boots; the key is simply treated as absent.

try {
  const existing = getCredentialSecret(null, API_KEY_CREDENTIAL_NAME)
  if (existing) {
    storedApiKey = existing
    currentSettings = { ...currentSettings, hasApiKey: true }
  }
} catch (err) {
  // The credential store / DB may be unavailable in some isolated
  // development setups; degrade gracefully rather than crashing startup.
  // The error is logged server-side only — never surfaced to clients and
  // never includes the secret material.
  console.error(
    '[settings] unable to load persisted AI API key from credential store:',
    (err as Error).message,
  )
}

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
    // Persist the key through the encrypted credential store so it is
    // encrypted at rest (AES-256-GCM) and survives server restarts.  Keep the
    // in-memory mirror in sync so the `storedApiKey` export reflects the
    // current value and the key is never included in currentSettings (which
    // would risk it being serialised and returned in GET responses).
    const trimmedKey = apiKey.trim()
    try {
      // Replace any previously stored key for this scope.  Removing first
      // guarantees a clean INSERT (the credential store keys the row by a
      // deterministic id, so an existing row would otherwise collide on the
      // primary key during an upsert).
      removeCredential(null, API_KEY_CREDENTIAL_NAME)
      saveCredential(null, API_KEY_CREDENTIAL_NAME, trimmedKey)
      storedApiKey = trimmedKey
      currentSettings = { ...currentSettings, hasApiKey: true }
    } catch (err) {
      // Never leak the secret or crypto internals to the client.
      console.error(
        '[settings] failed to persist AI API key to credential store:',
        (err as Error).message,
      )
      res.status(500).json({ error: 'Failed to persist API key' })
      return
    }
  }

  res.json(currentSettings)
})
