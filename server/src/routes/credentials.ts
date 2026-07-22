// ─────────────────────────────────────────────────────────────────────────────
// Credentials API router
//
// Exposes CRUD endpoints over the four supported credential types — `ssh`,
// `imap`, `smtp`, and `apikey` — backed by the encrypted credential store in
// server/src/services/credentials.ts.  All endpoints require authentication
// (requireAuth) and, for state-changing operations, a valid CSRF token
// (requireCsrf) when the client authenticates via cookie.
//
// Security properties:
//   – Secrets are NEVER returned by any endpoint.  PUT/POST accept the secret
//     in the request body and persist it (encrypted) via the credential
//     service; GET and list responses carry metadata only (id, key, type,
//     timestamps).
//   – Credentials are scoped to the authenticated user (req.user.id).  A user
//     can only read, update, or delete their own credentials; cross-user access
//     is impossible because the (user_id, key) lookup always filters by
//     req.user.id.
//   – The credential `type` is embedded in the stored key as `<type>:<name>`
//     (e.g. `ssh:prod-host`), which keeps the natural-key uniqueness provided
//     by the credentials table and lets the list endpoint reconstruct the type
//     without an extra column or join.
//   – Inputs are validated: the type must be one of the four allowed values,
//     `name` must be a non-empty bounded string with no control characters,
//     and `value` must be a non-empty string within a generous size limit.  The
//     underlying credential service re-validates, but the router validates
//     early so clients get a clear 400 rather than a 500.
//   – Errors from the credential service are wrapped with context and never
//     leak the raw crypto detail (see services/credentials.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express'
import { requireAuth, requireCsrf } from './auth.js'
import {
  saveCredential,
  getCredentialSecret,
  listCredentials,
  removeCredential,
  type CredentialMetadata,
} from '../services/credentials.js'

export const credentialsRouter = Router()

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The four credential types managed by this router.  Each type maps to a
 * distinct integration: SSH private keys, IMAP passwords, SMTP passwords, and
 * AI/3rd-party API keys.  The set is intentionally small and fixed so the
 * router can validate it strictly.
 */
const VALID_TYPES = ['ssh', 'imap', 'smtp', 'apikey'] as const
type CredentialType = (typeof VALID_TYPES)[number]

/** Separator between the credential type and the logical name in the stored key. */
const KEY_SEPARATOR = ':'

// Bounded lengths for the logical `name` portion of a credential key.  The
// credential service enforces an overall MAX_KEY_NAME_LEN (128); we keep the
// name shorter to leave room for the `<type>:` prefix.
const MAX_NAME_LEN = 100
const MAX_VALUE_LEN = 1024 * 64 // 64 KiB — generous upper bound for keys/passwords

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Type guard for the fixed credential-type union. */
function isCredentialType(value: unknown): value is CredentialType {
  return typeof value === 'string' && (VALID_TYPES as readonly string[]).includes(value)
}

/**
 * Validate the logical `name` portion of a credential key.  The name is used
 * inside the stored key (`<type>:<name>`) and is surfaced in list responses,
 * so it must be safe and bounded.  Mirrors the control-character rule from
 * the credential service to give a clear 400 before reaching the store.
 */
function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('name must be a non-empty string')
  }
  if (name.length > MAX_NAME_LEN) {
    throw new ValidationError(`name must be at most ${MAX_NAME_LEN} characters`)
  }
  // Reject control characters to prevent log-injection / display quirks.  A
  // name may not contain the key separator either, since it would break the
  // deterministic round-trip when reconstructing the type.
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new ValidationError('name must not contain control characters')
  }
  if (name.includes(KEY_SEPARATOR)) {
    throw new ValidationError(`name must not contain the '${KEY_SEPARATOR}' character`)
  }
}

/** Validate the secret value.  Non-empty, string, bounded length. */
function validateValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('value must be a non-empty string')
  }
  if (value.length > MAX_VALUE_LEN) {
    throw new ValidationError(`value must be at most ${MAX_VALUE_LEN} characters`)
  }
}

/**
 * Build the storage key from a credential type and logical name.  The
 * resulting key is the natural key used by the credential service, e.g.
 * `ssh:prod-host`.  Combining the type into the key avoids an extra DB
 * column while keeping the (user_id, key) uniqueness guarantee.
 */
function buildKey(type: CredentialType, name: string): string {
  return `${type}${KEY_SEPARATOR}${name}`
}

/**
 * Split a stored key back into its (type, name) components.  Returns null
 * when the key is not in the expected `<type>:<name>` shape (e.g. for legacy
 * or malformed rows), so the list endpoint can skip or safely label them.
 */
function parseKey(key: string): { type: string; name: string } | null {
  const sepIndex = key.indexOf(KEY_SEPARATOR)
  if (sepIndex <= 0) return null
  const type = key.slice(0, sepIndex)
  const name = key.slice(sepIndex + 1)
  if (!type || !name) return null
  return { type, name }
}

/**
 * Small validation-error class so handlers can distinguish expected client
 * errors (400) from unexpected service failures (500) without sniffing
 * message strings.
 */
class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * Project stored credential metadata into a client-safe response object.
 * Never includes the secret value, ciphertext, or IV.  The `type` and
 * `name` are reconstructed from the stored key so the client can identify
 * the credential without a separate column.
 */
function toResponseCredential(meta: CredentialMetadata): {
  id: string
  type: string
  name: string
  createdAt: string
  updatedAt: string
} {
  const parsed = parseKey(meta.key)
  return {
    id: meta.id,
    type: parsed?.type ?? 'unknown',
    name: parsed?.name ?? meta.key,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────

// Every endpoint requires a valid authenticated user.  requireAuth populates
// req.user with a safe user object (id, email, createdAt).
credentialsRouter.use(requireAuth)

// ── GET /api/credentials ──────────────────────────────────────────────────────
//
// Lists all credentials owned by the authenticated user as metadata only.
// Supports an optional `?type=<ssh|imap|smtp|apikey>` query filter.  Never
// returns secret material.

credentialsRouter.get('/', (req: Request, res: Response) => {
  const userId = req.user!.id
  const { type } = req.query

  if (type !== undefined && !isCredentialType(type)) {
    res
      .status(400)
      .json({ error: `Invalid credential type. Must be one of: ${VALID_TYPES.join(', ')}` })
    return
  }

  let all = listCredentials(userId)
  if (type) {
    const prefix = `${type as string}${KEY_SEPARATOR}`
    all = all.filter((c) => c.key.startsWith(prefix))
  }

  res.json({ credentials: all.map(toResponseCredential), count: all.length })
})

// ── GET /api/credentials/:type/:name ──────────────────────────────────────────
//
// Returns metadata for a single credential.  Like the list endpoint this
// never returns the secret value; it exists so a client can check existence
// and metadata for a specific credential.

credentialsRouter.get('/:type/:name', (req: Request, res: Response) => {
  const userId = req.user!.id
  const { type, name } = req.params

  if (!isCredentialType(type)) {
    res
      .status(400)
      .json({ error: `Invalid credential type. Must be one of: ${VALID_TYPES.join(', ')}` })
    return
  }

  let nameStr: string
  try {
    validateName(name)
    nameStr = name
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
    return
  }

  const exists = getCredentialSecret(userId, buildKey(type, nameStr)) !== undefined
  if (!exists) {
    res.status(404).json({ error: 'Credential not found' })
    return
  }

  // Reconstruct metadata from the list (avoids a separate DB helper and keeps
  // the response shape consistent with the list endpoint).  listCredentials
  // returns metadata only, so no secret material is ever touched here.
  const meta = listCredentials(userId).find((c) => c.key === buildKey(type, nameStr))
  if (!meta) {
    // Should not happen given the existence check above, but guard anyway.
    res.status(404).json({ error: 'Credential not found' })
    return
  }

  res.json(toResponseCredential(meta))
})

// ── PUT /api/credentials/:type/:name ──────────────────────────────────────────
//
// Create or replace a credential.  The secret `value` is accepted in the
// request body, encrypted at rest, and never echoed back.  Returns the
// metadata for the stored credential.

credentialsRouter.put(
  '/:type/:name',
  requireCsrf,
  (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user!.id
    const { type, name } = req.params
    const { value } = req.body as Record<string, unknown>

    if (!isCredentialType(type)) {
      res
        .status(400)
        .json({ error: `Invalid credential type. Must be one of: ${VALID_TYPES.join(', ')}` })
      return
    }

    let nameStr: string
    try {
      validateName(name)
      nameStr = name
      validateValue(value)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
      return
    }

    const key = buildKey(type, nameStr)
    try {
      saveCredential(userId, key, value)
    } catch (err) {
      // ValidationError → never expected here (we validated above), but a
      // defensive 400 keeps the contract clear.  Any other failure is a
      // service/encryption error — wrap with context and surface a 500.
      if (err instanceof ValidationError) {
        res.status(400).json({ error: (err as Error).message })
        return
      }
      // Never leak the raw crypto/storage detail; log server-side only.
      console.error(`[credentials] Failed to store credential for user ${userId}:`, err)
      res.status(500).json({ error: 'Failed to store credential' })
      return
    }

    // Read back metadata so the response shape matches the list endpoint.
    const meta = listCredentials(userId).find((c) => c.key === key)
    if (!meta) {
      // The save succeeded but the row is not visible; this indicates a
      // store inconsistency.  Surface a 500 rather than a misleading 200.
      console.error(`[credentials] Stored credential not found after save for user ${userId}`)
      res.status(500).json({ error: 'Failed to store credential' })
      return
    }

    res.status(201).json(toResponseCredential(meta))
  },
)

// ── DELETE /api/credentials/:type/:name ────────────────────────────────────────
//
// Remove a credential.  Idempotent from the client's perspective: a 200 is
// returned whether or not the credential existed, and the response body
// reports the resulting state (`deleted: boolean`).

credentialsRouter.delete(
  '/:type/:name',
  requireCsrf,
  (req: Request, res: Response) => {
    const userId = req.user!.id
    const { type, name } = req.params

    if (!isCredentialType(type)) {
      res
        .status(400)
        .json({ error: `Invalid credential type. Must be one of: ${VALID_TYPES.join(', ')}` })
      return
    }

    let nameStr: string
    try {
      validateName(name)
      nameStr = name
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
      return
    }

    let deleted: boolean
    try {
      deleted = removeCredential(userId, buildKey(type, nameStr))
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: (err as Error).message })
        return
      }
      console.error(`[credentials] Failed to delete credential for user ${userId}:`, err)
      res.status(500).json({ error: 'Failed to delete credential' })
      return
    }

    res.json({ type, name: nameStr, deleted })
  },
)
