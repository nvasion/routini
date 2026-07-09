/**
 * Notification service public API.
 *
 * Usage:
 *
 *   import { createNotifier, loadNotificationConfig } from './notifications/index.js'
 *
 *   const config = loadNotificationConfig()
 *   const notifier = createNotifier(config)   // undefined when disabled
 *   if (notifier) {
 *     const taskNotifier = new TaskNotifier(notifier, taskStore, userStore, {
 *       defaultToEmail: config.defaultToEmail,
 *     })
 *     const unsubscribe = taskNotifier.start(runBus)
 *     // … on shutdown:
 *     unsubscribe()
 *   }
 */

export {
  loadNotificationConfig,
  validateNotificationConfig,
  type NotificationConfig,
  type NotifyProvider,
  type SmtpConfig,
} from './config.js'

export { type Notifier, type NotificationMessage } from './types.js'

export { SmtpNotifier } from './smtpNotifier.js'
export { SendGridNotifier } from './sendgridNotifier.js'
export { TaskNotifier, type TaskNotifierOptions } from './taskNotifier.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { type NotificationConfig } from './config.js'
import { SmtpNotifier } from './smtpNotifier.js'
import { SendGridNotifier } from './sendgridNotifier.js'
import type { Notifier } from './types.js'

/**
 * Construct the appropriate `Notifier` from the given config.
 *
 * Returns `undefined` when `config.provider` is not set (i.e. notifications
 * are disabled). Callers should guard on the return value before wiring up
 * the `TaskNotifier` subscription.
 *
 * Throws if the config is enabled but missing required fields — fail fast at
 * startup rather than silently dropping notifications in production.
 */
export function createNotifier(config: NotificationConfig): Notifier | undefined {
  if (!config.provider) return undefined

  if (config.provider === 'smtp') {
    if (!config.smtp) {
      throw new Error(
        'createNotifier: SMTP provider selected but smtp config is missing. ' +
          'Set SMTP_HOST, SMTP_USER, and SMTP_PASS.',
      )
    }
    return new SmtpNotifier(config.smtp, config.fromEmail, config.fromName)
  }

  if (config.provider === 'sendgrid') {
    if (!config.sendgridApiKey) {
      throw new Error(
        'createNotifier: SendGrid provider selected but SENDGRID_API_KEY is missing.',
      )
    }
    return new SendGridNotifier(config.sendgridApiKey, config.fromEmail, config.fromName)
  }

  // TypeScript exhaustiveness guard — should never reach here.
  throw new Error(`createNotifier: unknown provider "${String(config.provider)}"`)
}
