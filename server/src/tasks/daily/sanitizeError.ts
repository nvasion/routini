/**
 * Credential-scrubbing helpers used by the daily task handlers.
 *
 * External clients (ssh2, IMAP over TLS, fetch) can throw errors whose message
 * or stack embeds pieces of the credentials the caller supplied — for example
 * an ssh2 error may echo back the "Password" argument, and an HTTP client may
 * include the request URL (which can carry userinfo) or the `Authorization`
 * header verbatim. Logging those raw would violate the PRD requirement that
 * secrets never appear in logs.
 *
 * These helpers do three things:
 *
 *   1. `redactCredentials(text, sensitive)` — replace every literal sensitive
 *      substring with the constant `[REDACTED]`. This handles the "credential
 *      shows up in a stringified error" case.
 *   2. `redactCommonSecrets(text)` — regex-driven pass that catches header
 *      lines (`Authorization: …`), URL userinfo (`https://user:pw@host`),
 *      and PEM key blocks. Used for defence in depth when we don't know the
 *      exact secret material up front.
 *   3. `sanitizeError(err, { sensitive, context })` — turn any thrown value
 *      into an `Error` with a message that has been passed through both
 *      passes and prefixed with a caller-supplied `context` string
 *      (`"ssh connection failed: …"`). The returned Error's `cause` is the
 *      original error so operators keep the stack trace server-side, but
 *      only the sanitised `message` is safe to relay to clients or store in
 *      TaskRun logs.
 *
 * Handlers MUST wrap *every* call into a third-party library with
 * `sanitizeError` — see the SSH/IMAP/HTTP handlers for examples.
 */

/** Constant string used to replace credentials in sanitised messages. */
export const REDACTED = '[REDACTED]'

/** Replacement patterns applied by `redactCommonSecrets`. Ordered by specificity. */
const COMMON_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // PEM-encoded private keys (single or multi-line). Match up to the matching
  // END line so we don't accidentally chew through the rest of the message.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // HTTP authorization / cookie / api-key header lines. Case-insensitive; we
  // preserve the header name so operators can still tell what was scrubbed.
  [/(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`],
  // URL userinfo — `scheme://user:pass@host` or `scheme://user@host`.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/?#]+(?::[^\s@/?#]*)?@/gi, `$1${REDACTED}@`],
  // Bearer / Basic tokens embedded inline (not just in headers).
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._\-]{4,}/g, `$1 ${REDACTED}`],
]

/** Escape a string so it can be embedded literally into a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace every literal occurrence of any `sensitive` string with `[REDACTED]`.
 *
 * - Empty / whitespace-only entries are ignored so a handler can pass in a
 *   `password ?? ''` field without accidentally redacting every character.
 * - Very short entries (< 4 chars) are also ignored — replacing a 1-char
 *   secret would blindly scrub common English letters from every message.
 * - Longest entries are replaced first so a 40-char token doesn't get
 *   partially rewritten by a 6-char substring of itself.
 */
export function redactCredentials(text: string, sensitive: ReadonlyArray<string | undefined>): string {
  if (text.length === 0) return text
  const seen = new Set<string>()
  const filtered: string[] = []
  for (const raw of sensitive) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length < 4) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    filtered.push(trimmed)
  }
  // Sort longest-first so overlapping secrets don't produce partial redactions.
  filtered.sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of filtered) {
    out = out.replace(new RegExp(escapeRegex(secret), 'g'), REDACTED)
  }
  return out
}

/**
 * Apply the built-in "well-known secrets" regex pass. Safe to call on any
 * string — patterns are anchored / greedy-limited so they won't run away on
 * pathological input.
 */
export function redactCommonSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of COMMON_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/** Options accepted by `sanitizeError`. */
export interface SanitizeErrorOptions {
  /** Literal credential strings to redact (passwords, tokens, PEM keys, …). */
  sensitive?: ReadonlyArray<string | undefined>
  /**
   * Human-readable context to prefix the sanitised message with. Handlers
   * pass values like `'ssh command failed'` so operators know which handler
   * emitted the error even after credentials have been stripped.
   */
  context?: string
}

/**
 * Extract a plain string message from any thrown value.
 *
 * `throw` accepts any value, so we can't assume `err.message` exists.
 * Non-Error throws are stringified defensively.
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Turn an arbitrary thrown value into a safe-to-log Error.
 *
 * The returned Error carries the original error as `cause` so the full stack
 * trace remains available server-side. Only the `message` — which is scrubbed
 * of caller-supplied credentials and well-known secret patterns — should be
 * surfaced to clients or persisted into task run logs.
 */
export function sanitizeError(err: unknown, options: SanitizeErrorOptions = {}): Error {
  const raw = extractMessage(err)
  const withoutLiterals = redactCredentials(raw, options.sensitive ?? [])
  const scrubbed = redactCommonSecrets(withoutLiterals)
  const prefix = options.context ? `${options.context}: ` : ''
  const wrapped = new Error(`${prefix}${scrubbed}`)
  // Preserve the original error for server-side observability. Callers that
  // log this should stringify only `.message`.
  if (err instanceof Error) {
    ;(wrapped as Error & { cause?: unknown }).cause = err
  }
  return wrapped
}
