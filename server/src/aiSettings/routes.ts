/**
 * AI settings routes — mounted under `/api/settings/ai`.
 *
 * Endpoints
 * ─────────
 *   GET  /api/settings/ai   Returns the caller's redacted settings view.
 *   PUT  /api/settings/ai   Updates a subset of the caller's settings.
 *
 * Both endpoints require an authenticated user (the parent router applies
 * `requireAuth`). The mutating `PUT` also requires
 * `Content-Type: application/json` for CSRF defense-in-depth — same policy as
 * the other state-changing endpoints in the app.
 *
 * Per-user isolation
 * ──────────────────
 * The user id comes from the verified JWT (`req.user!.id`), never from the
 * request body. That makes it structurally impossible for a caller to
 * overwrite another user's settings by including a foreign `userId` in the
 * payload.
 *
 * Redaction
 * ─────────
 * The response body never contains the plaintext API key — only a
 * `hasApiKey: boolean` flag. This matches the pattern used by
 * `sanitizeTask()` for SSH/email credentials.
 */

import { Router, type Request, type Response } from 'express'
import { csrfProtect } from '../auth/index.js'
import { AiSettingsStore } from './store.js'
import { validateUpdateAiSettings } from './validation.js'
import type { UpdateAiSettingsInput } from './types.js'

function errorResponse(
  message: string,
  details?: string[],
): { error: string; details?: string[] } {
  return details !== undefined ? { error: message, details } : { error: message }
}

export function createAiSettingsRouter(store: AiSettingsStore): Router {
  const router = Router()
  const csrf = csrfProtect()

  // GET /api/settings/ai — return the current user's redacted settings view.
  router.get('/', (req: Request, res: Response) => {
    const userId = req.user!.id
    res.json(store.getSettings(userId))
  })

  // PUT /api/settings/ai — partial update; only supplied fields change.
  router.put('/', csrf, (req: Request, res: Response) => {
    const errors = validateUpdateAiSettings(req.body)
    if (errors.length > 0) {
      res.status(400).json(errorResponse('Validation failed', errors))
      return
    }
    const userId = req.user!.id
    try {
      const view = store.updateSettings(userId, req.body as UpdateAiSettingsInput)
      res.json(view)
    } catch (err) {
      // Should be unreachable — validation catches malformed inputs and
      // encryption never fails on a well-formed string key. Log server-side
      // for diagnosis without exposing internals to the client.
      // eslint-disable-next-line no-console
      console.error('[ai-settings] update failed', {
        name: (err as Error).name,
        message: (err as Error).message,
      })
      res.status(500).json(errorResponse('Failed to update AI settings'))
    }
  })

  return router
}
