/**
 * IMAP Email Check Service
 *
 * Connects to an IMAP mailbox and counts (and optionally surfaces) messages
 * matching a configurable search criterion.  Designed for "check my inbox"
 * style daily tasks rather than full email processing.
 *
 * Configuration (from DailyTask.config — non-secret only):
 *   host            – IMAP server hostname (required)
 *   port            – IMAP port; default "993"
 *   username        – IMAP login name (required)
 *   mailbox         – mailbox folder to check; default "INBOX"
 *   searchCriteria  – what messages to count: "UNSEEN" | "SEEN" | "ALL" |
 *                     "FLAGGED" | "UNFLAGGED"; default "UNSEEN"
 *   tls             – "true" (default) or "false" for plain IMAP
 *
 * Credential resolution:
 *   The IMAP password is resolved from the encrypted credential store FIRST
 *   (stored under the system scope with key "IMAP_PASS"), falling back to the
 *   IMAP_PASS environment variable when nothing is stored.  This mirrors the
 *   store-first → env-var-fallback pattern established by the SSH and SMTP
 *   services so that secrets saved through the credentials API take
 *   precedence over process environment variables, while the original
 *   env-var behaviour is preserved as a default so existing deployments keep
 *   working unchanged.
 *
 * SECURITY:
 *   – Host is validated with isSsrfSafeHostname to block private/loopback IPs.
 *   – The password is never written to logs or error messages.
 *   – The imapflow internal logger is disabled to prevent credential leakage.
 *   – Credential values from the store are never logged; only the key NAME is
 *     safe to surface in (non-fatal) store-read-failure warnings.
 */

import { ImapFlow } from 'imapflow'
import type { DailyTask } from '../types.js'
import { isSsrfSafeHostname } from '../utils/network.js'
import { getCredentialSecret as getCredentialSecretFromStore } from './credentials.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImapTaskResult {
  success: boolean
  /** Ordered log lines describing what was found. */
  logs: string[]
  /** Number of messages matching the search criteria. */
  messageCount?: number
  /** Human-readable failure reason — never includes credentials. */
  error?: string
}

/** Configuration used internally after parsing and validation. */
export interface ImapCheckConfig {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  mailbox: string
  searchCriteria: ImapSearchCriteria
}

/** Supported search criteria labels (a subset of IMAP search). */
export type ImapSearchCriteriaLabel = 'UNSEEN' | 'SEEN' | 'ALL' | 'FLAGGED' | 'UNFLAGGED'

/** Search criteria object understood by imapflow. */
export type ImapSearchCriteria =
  | { seen: false }
  | { seen: true }
  | Record<string, never>        // {} → all messages
  | { flagged: true }
  | { flagged: false }

/** Low-level IMAP check contract — real implementation uses imapflow. */
export interface ImapExecutor {
  check(config: ImapCheckConfig): Promise<ImapCheckResult>
}

export interface ImapCheckResult {
  /** UIDs or sequence numbers of matching messages (used only for count). */
  matchingIds: number[]
}

/**
 * Resolves the IMAP password.
 *
 * Implementations MUST check the encrypted credential store first and fall
 * back to the IMAP_PASS environment variable only when nothing is stored.
 * Returning `undefined` (not the empty string) signals "not configured",
 * matching the original `process.env['IMAP_PASS']` lookup behaviour.
 *
 * Resolving the single secret through a dedicated resolver keeps the lookup
 * order (store-first → env-var fallback) consistent with the SSH and SMTP
 * services and makes the precedence unit-testable without a live database.
 */
export type ImapCredentialResolver = () => string | undefined

export interface ImapRunnerOptions {
  /**
   * Injectable executor.  The default implementation uses imapflow.
   * Pass a mock in unit tests to avoid requiring a real IMAP server.
   */
  executor?: ImapExecutor
  /**
   * Injectable credential resolver for the IMAP password.  The default
   * implementation checks the encrypted credential store first (system scope,
   * key "IMAP_PASS") and falls back to the IMAP_PASS environment variable when
   * nothing is stored.  Pass a mock in unit tests to control the credential
   * source without standing up a real credential store.
   */
  credentialResolver?: ImapCredentialResolver
}

// ── Credential store integration ──────────────────────────────────────────────
//
// The IMAP password is resolved from the encrypted credential store FIRST,
// falling back to the IMAP_PASS environment variable when nothing is stored.
// This mirrors the pattern established by the SSH and SMTP services: secrets
// saved through the credentials API take precedence over process environment
// variables, while the original env-var behaviour is preserved as a default
// so existing deployments keep working unchanged.
//
// The credential store (services/credentials.ts) uses a synchronous
// better-sqlite3 backend, so resolution here is synchronous too.  A store read
// failure (e.g. the DB is not yet initialised, or a decryption error) is
// non-fatal: it is logged server-side only (the key NAME, never the value)
// and resolution falls back to the environment variable, so a transient
// store issue never breaks IMAP tasks that could otherwise run with
// env-based credentials.
//
// The resolver is injectable (see `setImapCredentialResolver`) so unit tests
// can verify the store-first → env-var-fallback precedence without a live
// database, mirroring the injectable-resolver pattern used by the SMTP
// service.

/** Credential key under which the IMAP password is stored (system scope). */
const IMAP_PASS_KEY = 'IMAP_PASS'

/**
 * Default credential resolver.
 *
 * Lookup order:
 *   1. Encrypted credential store — checked first so that a password saved
 *      through the credentials API takes precedence over the process
 *      environment variable.  The IMAP password is system-scoped (shared
 *      mail-server configuration), so it is looked up under the `null`
 *      (system) userId — consistent with the SMTP credential handling in
 *      email.ts.
 *   2. `process.env['IMAP_PASS']` — the original source of the IMAP password,
 *      kept as a fallback so existing deployments that configure the secret
 *      via an env var continue to work unchanged.
 *
 * Returns `undefined` when neither source has a value.  Empty-string store
 * values are treated as "not set" so a blank stored secret never shadows a
 * real env-var value.
 */
const defaultImapCredentialResolver: ImapCredentialResolver = (): string | undefined => {
  try {
    const stored = getCredentialSecretFromStore(null, IMAP_PASS_KEY)
    if (stored && stored.trim() !== '') {
      return stored
    }
  } catch (err) {
    // A store read failure is non-fatal: fall through to the env-var fallback
    // so a transient DB/decryption issue does not break IMAP tasks that could
    // otherwise run with env-based credentials.  Log server-side only; never
    // include credential material in the message.
    console.warn(
      `[imap] Credential store read failed for "${IMAP_PASS_KEY}" — falling back to env var:`,
      err instanceof Error ? err.message : 'unknown error',
    )
  }
  const envValue = process.env['IMAP_PASS']
  return envValue && envValue.trim() !== '' ? envValue : undefined
}

/**
 * Active IMAP credential resolver.  Defaults to the store-first → env-var
 * fallback implementation; unit tests may override it via
 * `setImapCredentialResolver` to control precedence without a live database.
 */
let imapCredentialResolver: ImapCredentialResolver = defaultImapCredentialResolver

/**
 * Overrides the IMAP credential resolver.  Intended for unit tests that need
 * to verify the store-first → env-var-fallback precedence without standing up
 * a real credential store.  Pass `undefined` to restore the default resolver.
 *
 * @internal exported for tests; not part of the stable public API.
 */
export function setImapCredentialResolver(
  resolver: ImapCredentialResolver | undefined,
): void {
  imapCredentialResolver = resolver ?? defaultImapCredentialResolver
}

// ── Search criteria mapping ───────────────────────────────────────────────────

const CRITERIA_MAP: Record<ImapSearchCriteriaLabel, ImapSearchCriteria> = {
  UNSEEN:    { seen: false },
  SEEN:      { seen: true },
  ALL:       {},
  FLAGGED:   { flagged: true },
  UNFLAGGED: { flagged: false },
}

const VALID_CRITERIA = new Set<string>(Object.keys(CRITERIA_MAP))

function parseCriteria(raw: string): ImapSearchCriteria | null {
  const upper = raw.trim().toUpperCase() as ImapSearchCriteriaLabel
  return CRITERIA_MAP[upper] ?? null
}

// ── Default executor (wraps imapflow) ────────────────────────────────────────

class ImapFlowExecutor implements ImapExecutor {
  async check(config: ImapCheckConfig): Promise<ImapCheckResult> {
    // Disable internal logger entirely to prevent password from appearing in
    // any console output if imapflow logs connection details.
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.username, pass: config.password },
      logger: false,
    })

    try {
      await client.connect()

      let matchingIds: number[] = []
      const lock = await client.getMailboxLock(config.mailbox)
      try {
        const raw = await client.search(config.searchCriteria, { uid: true })
        matchingIds = Array.isArray(raw) ? raw : []
      } finally {
        lock.release()
      }

      await client.logout()
      return { matchingIds }
    } catch (err) {
      // Attempt a clean logout/close before rethrowing.
      try {
        await client.logout()
      } catch {
        // ignore — the connection may already be broken
      }
      throw err
    }
  }
}

const defaultExecutor = new ImapFlowExecutor()

// ── Validation ────────────────────────────────────────────────────────────────

interface ImapConfigValid {
  valid: true
  host: string
  port: number
  secure: boolean
  username: string
  mailbox: string
  searchCriteria: ImapSearchCriteria
}
interface ImapConfigInvalid {
  valid: false
  error: string
}
type ImapConfigValidation = ImapConfigValid | ImapConfigInvalid

function validateImapConfig(config: Record<string, string>): ImapConfigValidation {
  const host = config['host']?.trim()
  if (!host) {
    return { valid: false, error: 'IMAP task config is missing required field: host' }
  }
  if (!isSsrfSafeHostname(host)) {
    return {
      valid: false,
      error: `IMAP host "${host}" is not allowed: private or loopback addresses are blocked`,
    }
  }

  const rawPort = config['port'] ?? '993'
  const port = parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, error: `IMAP port "${rawPort}" is not a valid port number` }
  }

  const username = config['username']?.trim()
  if (!username) {
    return { valid: false, error: 'IMAP task config is missing required field: username' }
  }

  const rawTls = config['tls'] ?? 'true'
  const secure = rawTls !== 'false'

  const mailbox = config['mailbox']?.trim() || 'INBOX'

  const rawCriteria = config['searchCriteria']?.trim().toUpperCase() || 'UNSEEN'
  if (!VALID_CRITERIA.has(rawCriteria)) {
    return {
      valid: false,
      error: `Unknown searchCriteria "${config['searchCriteria']}". Supported: ${[...VALID_CRITERIA].join(', ')}`,
    }
  }
  const searchCriteria = parseCriteria(rawCriteria)!

  return { valid: true, host, port, secure, username, mailbox, searchCriteria }
}

// ── Service entry point ───────────────────────────────────────────────────────

/**
 * Connects to the IMAP mailbox configured in `task.config`, counts messages
 * matching the search criteria, and returns the result as logs + metadata.
 *
 * @param task     The DailyTask record (must have actionType === 'email').
 * @param options  Optional overrides for testing (inject a mock executor).
 */
export async function runImapTask(
  task: DailyTask,
  options: ImapRunnerOptions = {},
): Promise<ImapTaskResult> {
  const executor = options.executor ?? defaultExecutor
  const cfg = validateImapConfig(task.config)
  if (!cfg.valid) {
    return { success: false, logs: [], error: cfg.error }
  }

  // Resolve the IMAP password through the credential resolver, which checks
  // the encrypted credential store first and falls back to the IMAP_PASS
  // environment variable when nothing is stored.  An injectable resolver
  // (options.credentialResolver) takes precedence so unit tests can control
  // the credential source without standing up a real store; otherwise the
  // module-level resolver (defaulting to store-first → env-var fallback) is
  // used.  Provider errors are wrapped into a clean failure result so a
  // transient store/decryption failure never crashes the task runner —
  // preserving the documented { success, logs, error } response shape.
  // Credential material is never included in the surfaced error message.
  const resolvePassword = options.credentialResolver ?? imapCredentialResolver
  let password: string | undefined
  try {
    password = resolvePassword()
  } catch (err) {
    console.warn(
      '[imap] Credential resolution failed:',
      err instanceof Error ? err.message : 'unknown error',
    )
    return {
      success: false,
      logs: [],
      error: 'Failed to resolve IMAP credentials. Check the credential store configuration.',
    }
  }

  if (!password) {
    return {
      success: false,
      logs: [],
      error: 'No IMAP credentials configured. Set IMAP_PASS environment variable.',
    }
  }

  const logs: string[] = [
    `Connecting to IMAP server ${cfg.host}:${cfg.port} (TLS: ${cfg.secure})…`,
    `Checking mailbox: ${cfg.mailbox}`,
  ]

  try {
    const result = await executor.check({ ...cfg, password })

    const count = result.matchingIds.length
    const criteriaLabel = (task.config['searchCriteria'] ?? 'UNSEEN').toUpperCase()
    logs.push(`Found ${count} message(s) matching criteria: ${criteriaLabel}`)

    return { success: true, logs, messageCount: count }
  } catch (err) {
    // Avoid including raw imapflow error messages — they may contain capability
    // banners with server/version info useful for fingerprinting.
    const msg = err instanceof Error ? err.message : 'Unexpected IMAP error'
    // Sanitize: never log passwords even if they appear in the error
    const safeMsg = msg.replace(/\b(password|pass|auth)[\s=:]+\S+/gi, '$1=[REDACTED]')
    logs.push(`IMAP error: ${safeMsg}`)
    return {
      success: false,
      logs,
      error: `[task:${task.id}] IMAP check failed: ${safeMsg}`,
    }
  }
}
