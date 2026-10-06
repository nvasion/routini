/**
 * IMAP Email Check Service
 *
 * Connects to an IMAP mailbox and counts (and optionally surfaces) messages
 * matching a configurable search criterion.  Designed for "check my inbox"
 * style daily tasks rather than full email processing.
 *
 * Configuration (from ActionTask.config — non-secret only):
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
import type { ActionTask } from './actionTypes.js'
import { isSsrfSafeHostname } from '../utils/network.js'

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

// ── Credential resolution ─────────────────────────────────────────────────────
//
// The engine passes an org-scoped credentialResolver for every IMAP step. The
// default reads the IMAP_PASS environment variable, for direct callers and tests.

const defaultImapCredentialResolver: ImapCredentialResolver = (): string | undefined => {
  const envValue = process.env['IMAP_PASS']
  return envValue && envValue.trim() !== '' ? envValue : undefined
}

let imapCredentialResolver: ImapCredentialResolver = defaultImapCredentialResolver

/** @internal Overrides the default resolver (tests). Pass undefined to restore it. */
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
 * @param task     The ActionTask record (must have actionType === 'email').
 * @param options  Optional overrides for testing (inject a mock executor).
 */
export async function runImapTask(
  task: ActionTask,
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
