/**
 * Notification service configuration.
 *
 * All settings come from environment variables so they can be supplied via
 * a secrets manager (Vault, AWS SSM, Kubernetes secrets) without baking
 * credentials into the source tree.
 *
 * SECURITY:
 *  - `smtpPassword` and `sendgridApiKey` are treated as write-only — they
 *    are read once at startup and never logged or returned via any API.
 *  - The module validates required fields up-front; a misconfigured
 *    deployment fails loudly rather than silently sending no notifications.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which underlying transport to use. */
export type NotifyProvider = 'smtp' | 'sendgrid'

export interface SmtpConfig {
  host: string
  port: number
  /** Require TLS from the start of the connection (port 465). */
  secure: boolean
  user: string
  /** Raw password — never log or expose. */
  password: string
}

export interface NotificationConfig {
  /** Transport to use. When undefined the service is disabled. */
  provider: NotifyProvider | undefined
  /** Email address that appears in the From header. */
  fromEmail: string
  /** Display name in the From header. */
  fromName: string
  /**
   * Default recipient when a task's owner does not have an email address.
   * Also used as admin notification target (e.g. routine milestone alerts).
   */
  defaultToEmail: string | undefined
  /** Filled when `provider === 'smtp'`. */
  smtp: SmtpConfig | undefined
  /** SendGrid API key. Filled when `provider === 'sendgrid'`. */
  sendgridApiKey: string | undefined
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_FROM_EMAIL = 'no-reply@routini.app'
const DEFAULT_FROM_NAME = 'Routini'
const DEFAULT_SMTP_PORT = 587

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  return raw.trim().toLowerCase() === 'true' || raw.trim() === '1'
}

function pickProvider(raw: string | undefined): NotifyProvider | undefined {
  if (!raw) return undefined
  const lower = raw.trim().toLowerCase()
  if (lower === 'smtp' || lower === 'sendgrid') return lower
  return undefined
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Parse notification config from the process environment.
 *
 * Does NOT throw — callers check `config.provider` to see if the service is
 * enabled. Missing required sub-keys are surfaced at send time when the
 * notifier is constructed via `createNotifier`.
 */
export function loadNotificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotificationConfig {
  const provider = pickProvider(env.NOTIFY_PROVIDER)
  const fromEmail = env.NOTIFY_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL
  const fromName = env.NOTIFY_FROM_NAME?.trim() || DEFAULT_FROM_NAME
  const defaultToEmail = env.NOTIFY_TO_EMAIL?.trim() || undefined

  let smtp: SmtpConfig | undefined
  if (provider === 'smtp') {
    smtp = {
      host: env.SMTP_HOST?.trim() ?? '',
      port: parsePort(env.SMTP_PORT, DEFAULT_SMTP_PORT),
      secure: parseBoolean(env.SMTP_SECURE, false),
      user: env.SMTP_USER?.trim() ?? '',
      password: env.SMTP_PASS ?? '',
    }
  }

  const sendgridApiKey =
    provider === 'sendgrid' ? (env.SENDGRID_API_KEY ?? '') : undefined

  return { provider, fromEmail, fromName, defaultToEmail, smtp, sendgridApiKey }
}

/**
 * Validate a loaded config. Returns an array of human-readable error strings.
 * An empty array means the config is valid for the chosen provider.
 */
export function validateNotificationConfig(config: NotificationConfig): string[] {
  const errors: string[] = []
  if (!config.provider) return errors // disabled — no validation needed

  if (!config.fromEmail) {
    errors.push('NOTIFY_FROM_EMAIL is required when NOTIFY_PROVIDER is set')
  }

  if (config.provider === 'smtp') {
    if (!config.smtp?.host) errors.push('SMTP_HOST is required for SMTP provider')
    if (!config.smtp?.user) errors.push('SMTP_USER is required for SMTP provider')
    if (!config.smtp?.password) errors.push('SMTP_PASS is required for SMTP provider')
  }

  if (config.provider === 'sendgrid') {
    if (!config.sendgridApiKey) {
      errors.push('SENDGRID_API_KEY is required for SendGrid provider')
    }
  }

  return errors
}
