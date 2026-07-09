/**
 * Core notification abstractions.
 *
 * Keeping the interface minimal means either transport (SMTP, SendGrid API,
 * a future Slack adapter, …) can satisfy it without changing callers.
 */

// ---------------------------------------------------------------------------
// Message shape
// ---------------------------------------------------------------------------

/**
 * A notification message ready to send. Both `text` and `html` are required
 * so that each transport can pick the representation it supports and so
 * recipients with plain-text-only mail clients still receive a readable body.
 */
export interface NotificationMessage {
  /** Recipient email address. */
  to: string
  /** Email subject line. */
  subject: string
  /** Plain-text body (required for accessibility). */
  text: string
  /** HTML body — must convey the same information as `text`. */
  html: string
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

/**
 * Anything that can deliver a `NotificationMessage`. The interface is
 * intentionally small so new transports (SMS, webhook, Slack) are trivial
 * to add: implement `send` and swap at the composition root.
 *
 * Implementations MUST:
 *  - Throw with a descriptive error (including context) when delivery fails.
 *  - Never log the `to` address or message body at INFO level — recipient
 *    addresses and message content are PII.
 *  - Never throw synchronously; always return a rejected Promise on error.
 */
export interface Notifier {
  send(msg: NotificationMessage): Promise<void>
}
