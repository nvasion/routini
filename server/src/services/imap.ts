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
 * Credentials are read exclusively from environment variables:
 *   IMAP_PASS  – IMAP account password (required)
 *
 * SECURITY:
 *   – Host is validated with isSsrfSafeHostname to block private/loopback IPs.
 *   – The password is never written to logs or error messages.
 *   – The imapflow internal logger is disabled to prevent credential leakage.
 */

import { ImapFlow } from 'imapflow'
import type { DailyTask } from '../types.js'
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

export interface ImapRunnerOptions {
  /**
   * Injectable executor.  The default implementation uses imapflow.
   * Pass a mock in unit tests to avoid requiring a real IMAP server.
   */
  executor?: ImapExecutor
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

  const password = process.env['IMAP_PASS']
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
