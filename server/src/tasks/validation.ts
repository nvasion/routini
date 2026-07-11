/**
 * Input validation for task create/update operations.
 *
 * All validators return an array of human-readable error strings. An empty
 * array means the input is valid. The callers (route handlers) convert these
 * to 400 responses.
 *
 * Security notes:
 *  - URL fields are checked against an SSRF allowlist (no private ranges,
 *    loopback, link-local, or cloud metadata endpoints).
 *  - HTTP header keys/values are rejected if they contain newlines (header
 *    injection prevention).
 *  - We do NOT validate that referenced taskIds in routine steps actually
 *    exist in the store — that would couple validation to persistence and
 *    make validation impure. Referential integrity is checked at execute time.
 */

import type {
  AgentName,
  CreateDailyTaskInput,
  CreateDevelopmentalTaskInput,
  CreateRoutineTaskInput,
  CreateTaskInput,
  DailySubtype,
  EmailConfig,
  HttpConfig,
  HttpMethod,
  RoutineStep,
  ScheduleConfig,
  ScheduleType,
  SshConfig,
  Task,
  UpdateDailyTaskInput,
  UpdateDevelopmentalTaskInput,
  UpdateRoutineTaskInput,
} from './types.js'
import { isValidConditionSyntax } from './routine/condition.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 200
const MAX_BRANCH_NAME_LENGTH = 100
const MAX_CONDITION_LENGTH = 500
const MAX_ROUTINE_STEPS = 50
const MAX_HTTP_HEADERS = 50
const MAX_HEADER_KEY_LENGTH = 200
const MAX_HEADER_VALUE_LENGTH = 2_000
const MAX_SSH_COMMAND_LENGTH = 2_000
const MIN_PORT = 1
const MAX_PORT = 65_535
const MAX_PASSWORD_LIKE_FIELD = 500
/**
 * Maximum length for a PEM-encoded private key. RSA-4096 keys are ~3400 chars;
 * this limit allows headroom while bounding the stored size.
 */
const MAX_PRIVATE_KEY_LENGTH = 8_192

export const VALID_AGENTS: AgentName[] = ['opencode', 'claude-code', 'omnimancer']
export const VALID_SUBTYPES: DailySubtype[] = ['ssh', 'email', 'http']
export const VALID_HTTP_METHODS: HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
]

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * Parses a dotted-decimal IPv4 address using strict decimal-only notation.
 * Returns the four octets as numbers, or `null` if the string is not in that form.
 *
 * Security: only pure decimal octets are accepted (no leading zeros for multi-digit
 * values, no hex 0x prefix). This prevents Number('0177') being treated as decimal
 * 177 when an underlying library would interpret "0177" as octal 127.
 */
function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  // Reject any non-decimal notation: only sequences of ASCII digits with no
  // leading zero on a multi-digit value (no octal like 0177, no hex like 0x7f).
  if (parts.some((p) => !/^\d+$/.test(p) || (p.length > 1 && p[0] === '0'))) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

/**
 * Returns `true` if the hostname should be blocked to prevent SSRF.
 *
 * Covered:
 *  - Named: "localhost", "0.0.0.0"
 *  - Loopback: 127.0.0.0/8, ::1
 *  - Link-local / cloud metadata: 169.254.0.0/16, fe80::/10
 *  - Private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *  - IETF protocol assignments: 192.0.0.0/24
 *  - CGNAT / Shared Address Space: 100.64.0.0/10 (RFC 6598)
 *  - Multicast: 224.0.0.0/4
 *  - Reserved / future use: 240.0.0.0/4 (includes 255.255.255.255)
 *  - IPv6 unique-local: fc00::/7 (fc:: and fd:: prefixes)
 *  - IPv6-mapped IPv4: ::ffff:<private-ipv4>
 *  - Non-standard dotted-decimal (octal 0177.x, hex 0x7f.x) — blocked
 *    conservatively because underlying libraries may interpret them differently.
 *
 * Remaining limitation: single-integer IPv4 representations like 2130706433
 * (= 127.0.0.1) are not caught here. A production deployment should resolve
 * hostnames in a network-isolated sandbox before initiating any connection.
 */
export function isSsrfUnsafeHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets

  // Named loopback / wildcard
  if (h === 'localhost' || h === '0.0.0.0') return true

  // IPv6 loopback and link-local
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd'))
    return true

  // IPv6-mapped IPv4 (::ffff:a.b.c.d).
  // Block if the embedded IPv4 part is itself disallowed.
  if (h.startsWith('::ffff:')) {
    const v4part = h.slice(7) // strip '::ffff:'
    if (isSsrfUnsafeHostname(v4part)) return true
  }

  // Reject non-standard dotted notation (octal leading-zero octets like 0177.0.0.1,
  // or hex segments like 0x7f.0.0.1).  These are ambiguous: our decimal parser
  // would silently treat "0177" as 177, while the OS or a C library may treat it
  // as octal 127 (loopback).  Block conservatively rather than parse incorrectly.
  const dotParts = h.split('.')
  if (
    dotParts.length > 1 &&
    dotParts.some((p) => /^0x/i.test(p) || (/^\d/.test(p) && p.length > 1 && p[0] === '0'))
  ) {
    return true
  }

  const octets = parseIpv4Octets(h)
  if (octets) {
    const [a, b, c] = octets
    if (a === 0) return true                          // 0.0.0.0/8
    if (a === 10) return true                         // 10.0.0.0/8 (private)
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 (CGNAT, RFC 6598)
    if (a === 127) return true                        // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true           // 169.254.0.0/16 (link-local / metadata)
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12 (private)
    if (a === 192 && b === 0 && c === 0) return true  // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 168) return true           // 192.168.0.0/16 (private)
    if (a >= 224) return true                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  }

  return false
}

/**
 * Validates that a URL is well-formed, uses http/https, and targets a
 * non-private host.
 *
 * Security: only http and https are accepted. Schemes such as file://, ftp://,
 * gopher://, data:, and javascript: are explicitly disallowed to prevent
 * local-file reads, SSRF via alternative protocols, and XSS injection.
 * Hostname SSRF checks are applied after scheme validation.
 */
export function validateUrl(raw: string, fieldName: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return [`${fieldName}: must be a valid URL`]
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return [
      `${fieldName}: only http and https schemes are allowed` +
        ` (got "${parsed.protocol.replace(/:$/, '')}"; file, ftp, gopher, data, and javascript are not permitted)`,
    ]
  }
  if (isSsrfUnsafeHostname(parsed.hostname)) {
    return [`${fieldName}: URL targets a disallowed host`]
  }
  return []
}

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------

function validateName(name: unknown): string[] {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return ['name: must be a non-empty string']
  }
  if (name.length > MAX_NAME_LENGTH) {
    return [`name: must not exceed ${MAX_NAME_LENGTH} characters`]
  }
  return []
}

/**
 * Validates a cron expression with five space-separated fields. Only the
 * structural form is checked — semantically invalid values (e.g. minute=99)
 * are caught at scheduling time by the underlying cron library.
 */
export function validateCron(expr: string): string[] {
  // Allow alphanumeric, commas, hyphens, slashes, asterisks, and spaces
  if (!/^[\d*,\-/]+( [\d*,\-/]+){4}$/.test(expr.trim())) {
    return ['schedule.cron: must be a valid five-field cron expression (e.g. "0 9 * * 1-5")']
  }
  return []
}

function validateSchedule(schedule: unknown): string[] {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return ['schedule: must be an object']
  }
  const s = schedule as Record<string, unknown>
  const validTypes: ScheduleType[] = ['manual', 'cron']
  if (!validTypes.includes(s.type as ScheduleType)) {
    return ['schedule.type: must be "manual" or "cron"']
  }
  if (s.type === 'cron') {
    if (typeof s.cron !== 'string' || s.cron.trim().length === 0) {
      return ['schedule.cron: required when type is "cron"']
    }
    return validateCron(s.cron)
  }
  return []
}

/**
 * Valid git branch name. Conservative subset of what git allows:
 * starts with alphanumeric or underscore, contains alphanumerics,
 * hyphens, underscores, or forward slashes (for hierarchy).
 */
export function validateBranchName(name: string): string[] {
  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    return [`branchName: must not exceed ${MAX_BRANCH_NAME_LENGTH} characters`]
  }
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_\-/]*$/.test(name)) {
    return [
      'branchName: must start with a letter, digit, or underscore and contain only' +
        ' letters, digits, hyphens, underscores, or forward slashes',
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// Sub-config validators
// ---------------------------------------------------------------------------

/**
 * Regex that matches characters/sequences that could enable command injection
 * when a command string is later interpolated into a shell context (e.g. passed
 * via execSync or embedded in a larger shell command).
 *
 * - \x00 — null byte: can truncate C strings, bypass length checks
 * - \r\n  — carriage-return / newline: can inject new shell commands
 * - `...` — backtick command substitution
 * - $(...) — POSIX command substitution
 *
 * Standard shell operators (|, ;, &&, ||) are intentionally permitted: they
 * are legitimate parts of many SSH commands (e.g. "cd /app && npm start") and
 * do not introduce injection risk when the command is passed directly to the
 * remote shell over the SSH protocol rather than interpolated into a local
 * shell string.
 */
const DANGEROUS_COMMAND_PATTERN = /[\x00\r\n]|`|\$\(/

function validateSshConfig(cfg: unknown): string[] {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['config: must be an object for SSH tasks']
  }
  const errors: string[] = []
  const c = cfg as Record<string, unknown>

  if (typeof c.host !== 'string' || c.host.trim().length === 0) {
    errors.push('config.host: required')
  } else if (isSsrfUnsafeHostname(c.host.trim())) {
    // Block connections to private/loopback addresses to prevent SSRF via the
    // SSH client connecting back to internal infrastructure.
    errors.push('config.host: host targets a disallowed address')
  }
  if (c.port !== undefined) {
    const p = Number(c.port)
    if (!Number.isInteger(p) || p < MIN_PORT || p > MAX_PORT) {
      errors.push(`config.port: must be an integer between ${MIN_PORT} and ${MAX_PORT}`)
    }
  }
  if (typeof c.username !== 'string' || c.username.trim().length === 0) {
    errors.push('config.username: required')
  }
  if (typeof c.command !== 'string' || c.command.trim().length === 0) {
    errors.push('config.command: required')
  } else if (c.command.length > MAX_SSH_COMMAND_LENGTH) {
    errors.push(`config.command: must not exceed ${MAX_SSH_COMMAND_LENGTH} characters`)
  } else if (DANGEROUS_COMMAND_PATTERN.test(c.command)) {
    errors.push(
      'config.command: must not contain null bytes, newlines, backticks, or command substitution ($())',
    )
  }
  // Sensitive credential fields — validate size limits only.
  // Content is intentionally not inspected to avoid logging secrets.
  // These fields are write-only: the API strips them from all responses.
  if (c.password !== undefined) {
    if (typeof c.password !== 'string') {
      errors.push('config.password: must be a string when provided')
    } else if (c.password.length > MAX_PASSWORD_LIKE_FIELD) {
      errors.push(`config.password: must not exceed ${MAX_PASSWORD_LIKE_FIELD} characters`)
    }
  }
  if (c.privateKey !== undefined) {
    if (typeof c.privateKey !== 'string') {
      errors.push('config.privateKey: must be a string when provided')
    } else if (c.privateKey.length > MAX_PRIVATE_KEY_LENGTH) {
      errors.push(`config.privateKey: must not exceed ${MAX_PRIVATE_KEY_LENGTH} characters`)
    }
  }
  return errors
}

function validateEmailConfig(cfg: unknown): string[] {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['config: must be an object for email tasks']
  }
  const errors: string[] = []
  const c = cfg as Record<string, unknown>

  if (typeof c.host !== 'string' || c.host.trim().length === 0) {
    errors.push('config.host: required')
  } else if (isSsrfUnsafeHostname(c.host.trim())) {
    // Block connections to private/loopback addresses to prevent SSRF via the
    // IMAP client connecting back to internal infrastructure.
    errors.push('config.host: host targets a disallowed address')
  }
  if (c.port !== undefined) {
    const p = Number(c.port)
    if (!Number.isInteger(p) || p < MIN_PORT || p > MAX_PORT) {
      errors.push(`config.port: must be an integer between ${MIN_PORT} and ${MAX_PORT}`)
    }
  }
  if (typeof c.username !== 'string' || c.username.trim().length === 0) {
    errors.push('config.username: required')
  }
  if (c.folder !== undefined && typeof c.folder !== 'string') {
    errors.push('config.folder: must be a string when provided')
  }
  // Sensitive credential field — validate size only, never log content.
  // The API strips this field from all responses (write-only).
  if (c.password !== undefined) {
    if (typeof c.password !== 'string') {
      errors.push('config.password: must be a string when provided')
    } else if (c.password.length > MAX_PASSWORD_LIKE_FIELD) {
      errors.push(`config.password: must not exceed ${MAX_PASSWORD_LIKE_FIELD} characters`)
    }
  }
  return errors
}

function validateHttpConfig(cfg: unknown): string[] {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['config: must be an object for HTTP tasks']
  }
  const errors: string[] = []
  const c = cfg as Record<string, unknown>

  if (typeof c.url !== 'string') {
    errors.push('config.url: required')
  } else {
    errors.push(...validateUrl(c.url, 'config.url'))
  }

  if (c.method !== undefined && !VALID_HTTP_METHODS.includes(c.method as HttpMethod)) {
    errors.push(`config.method: must be one of ${VALID_HTTP_METHODS.join(', ')}`)
  }

  if (c.headers !== undefined) {
    if (typeof c.headers !== 'object' || Array.isArray(c.headers) || c.headers === null) {
      errors.push('config.headers: must be a plain object')
    } else {
      const hdrs = c.headers as Record<string, unknown>
      const keys = Object.keys(hdrs)
      if (keys.length > MAX_HTTP_HEADERS) {
        errors.push(`config.headers: must not exceed ${MAX_HTTP_HEADERS} entries`)
      }
      for (const key of keys) {
        if (key.length === 0 || key.length > MAX_HEADER_KEY_LENGTH) {
          errors.push(`config.headers: key "${key.slice(0, 30)}" has invalid length`)
        }
        if (/[\r\n]/.test(key)) {
          errors.push('config.headers: header key must not contain newline characters')
        }
        const val = hdrs[key]
        if (typeof val !== 'string') {
          errors.push(`config.headers: value for key "${key.slice(0, 30)}" must be a string`)
        } else {
          if (val.length > MAX_HEADER_VALUE_LENGTH) {
            errors.push(
              `config.headers: value for key "${key.slice(0, 30)}" exceeds ${MAX_HEADER_VALUE_LENGTH} characters`,
            )
          }
          if (/[\r\n]/.test(val)) {
            errors.push(
              `config.headers: value for key "${key.slice(0, 30)}" must not contain newline characters`,
            )
          }
        }
      }
    }
  }
  return errors
}

function validateDailyConfig(subtype: DailySubtype, cfg: unknown): string[] {
  switch (subtype) {
    case 'ssh':
      return validateSshConfig(cfg)
    case 'email':
      return validateEmailConfig(cfg)
    case 'http':
      return validateHttpConfig(cfg)
  }
}

function validateRoutineSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return ['steps: must be an array']
  if (steps.length === 0) return ['steps: must contain at least one step']
  if (steps.length > MAX_ROUTINE_STEPS) {
    return [`steps: must not exceed ${MAX_ROUTINE_STEPS} steps`]
  }
  const errors: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Record<string, unknown>
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`steps[${i}]: must be an object`)
      continue
    }
    if (typeof step.taskId !== 'string' || step.taskId.trim().length === 0) {
      errors.push(`steps[${i}].taskId: required`)
    }
    if (step.condition !== undefined) {
      if (typeof step.condition !== 'string') {
        errors.push(`steps[${i}].condition: must be a string when provided`)
      } else if (step.condition.length > MAX_CONDITION_LENGTH) {
        errors.push(
          `steps[${i}].condition: must not exceed ${MAX_CONDITION_LENGTH} characters`,
        )
      } else if (!isValidConditionSyntax(step.condition)) {
        errors.push(
          `steps[${i}].condition: unrecognized condition syntax. ` +
            `Supported forms: previous.status === '<status>' or previous.status !== '<status>' ` +
            `where <status> is one of: queued, running, succeeded, failed`,
        )
      }
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

export function validateCreateTask(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['request body must be a JSON object']
  }
  const b = body as Record<string, unknown>
  const errors: string[] = []

  errors.push(...validateName(b.name))

  const { type } = b
  if (type === 'daily') {
    const input = b as Partial<CreateDailyTaskInput>
    if (!VALID_SUBTYPES.includes(input.subtype as DailySubtype)) {
      errors.push(`subtype: must be one of ${VALID_SUBTYPES.join(', ')}`)
    } else {
      errors.push(...validateDailyConfig(input.subtype as DailySubtype, input.config))
    }
    if (input.schedule !== undefined) {
      errors.push(...validateSchedule(input.schedule))
    }
  } else if (type === 'developmental') {
    const input = b as Partial<CreateDevelopmentalTaskInput>
    if (typeof input.repoUrl !== 'string') {
      errors.push('repoUrl: required')
    } else {
      errors.push(...validateUrl(input.repoUrl, 'repoUrl'))
    }
    if (!VALID_AGENTS.includes(input.agentName as AgentName)) {
      errors.push(`agentName: must be one of ${VALID_AGENTS.join(', ')}`)
    }
    if (input.branchName !== undefined) {
      errors.push(...validateBranchName(input.branchName as string))
    }
  } else if (type === 'routine') {
    const input = b as Partial<CreateRoutineTaskInput>
    errors.push(...validateRoutineSteps(input.steps))
  } else {
    errors.push('type: must be one of daily, developmental, routine')
  }

  return errors
}

/**
 * Validate a partial update body. The `existingTask` is provided so we can
 * cross-validate fields (e.g. changing subtype requires a matching config).
 */
export function validateUpdateTask(body: unknown, existingTask: Task): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['request body must be a JSON object']
  }
  const b = body as Record<string, unknown>
  const errors: string[] = []

  if (b.name !== undefined) {
    errors.push(...validateName(b.name))
  }

  if (existingTask.type === 'daily') {
    const patch = b as Partial<UpdateDailyTaskInput>
    // Determine effective subtype for config validation
    const effectiveSubtype = (patch.subtype as DailySubtype) ?? existingTask.subtype
    if (patch.subtype !== undefined && !VALID_SUBTYPES.includes(patch.subtype)) {
      errors.push(`subtype: must be one of ${VALID_SUBTYPES.join(', ')}`)
    }
    if (patch.config !== undefined) {
      const subtypeForValidation =
        patch.subtype !== undefined ? (patch.subtype as DailySubtype) : effectiveSubtype
      errors.push(...validateDailyConfig(subtypeForValidation, patch.config))
    }
    // If subtype is changing, config must also be provided
    if (patch.subtype !== undefined && patch.subtype !== existingTask.subtype && patch.config === undefined) {
      errors.push('config: must be provided when changing subtype')
    }
    if (patch.schedule !== undefined) {
      errors.push(...validateSchedule(patch.schedule))
    }
  } else if (existingTask.type === 'developmental') {
    const patch = b as Partial<UpdateDevelopmentalTaskInput>
    if (patch.repoUrl !== undefined) {
      errors.push(...validateUrl(patch.repoUrl as string, 'repoUrl'))
    }
    if (patch.agentName !== undefined && !VALID_AGENTS.includes(patch.agentName as AgentName)) {
      errors.push(`agentName: must be one of ${VALID_AGENTS.join(', ')}`)
    }
    if (patch.branchName !== undefined) {
      errors.push(...validateBranchName(patch.branchName as string))
    }
  } else if (existingTask.type === 'routine') {
    const patch = b as Partial<UpdateRoutineTaskInput>
    if (patch.steps !== undefined) {
      errors.push(...validateRoutineSteps(patch.steps))
    }
  }

  return errors
}

// Type-safe casting helpers used by route handlers
export function asSshConfig(cfg: unknown): SshConfig {
  return cfg as SshConfig
}
export function asEmailConfig(cfg: unknown): EmailConfig {
  return cfg as EmailConfig
}
export function asHttpConfig(cfg: unknown): HttpConfig {
  return cfg as HttpConfig
}
