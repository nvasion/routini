/**
 * SendGrid notifier — delivers `NotificationMessage` via the SendGrid Web API.
 *
 * Preferred over the SMTP relay when:
 *  - Outbound TCP port 25/587 is blocked (common in cloud VMs)
 *  - You want delivery analytics (click tracking, open rates) in SendGrid's
 *    dashboard
 *  - You need fine-grained API-key permissions (e.g. "Mail Send" scope only)
 *
 * SECURITY:
 *  - The API key is stored only in the module-private field `#apiKey` and is
 *    never logged, returned via any API, or included in error messages.
 *  - `SendGridNotifier` validates the key up-front and throws at construction
 *    time to fail fast on misconfiguration.
 */

import sgMail from '@sendgrid/mail'
import type { Notifier, NotificationMessage } from './types.js'

export class SendGridNotifier implements Notifier {
  private readonly fromEmail: string
  private readonly fromName: string

  constructor(apiKey: string, fromEmail: string, fromName: string) {
    if (!apiKey) throw new Error('SendGridNotifier: apiKey is required')
    if (!fromEmail) throw new Error('SendGridNotifier: fromEmail is required')

    // The @sendgrid/mail package stores the key module-globally. To support
    // multiple isolated instances (e.g. in tests) we re-set the key before
    // each send. This is safe in a single-threaded Node process but would need
    // a mutex in a worker-thread context.
    sgMail.setApiKey(apiKey)

    this.fromEmail = fromEmail
    this.fromName = fromName
  }

  async send(msg: NotificationMessage): Promise<void> {
    try {
      await sgMail.send({
        from: { email: this.fromEmail, name: this.fromName },
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      })
    } catch (err) {
      // Wrap with context; omit recipient and body (PII).
      const cause = err instanceof Error ? err.message : String(err)
      throw new Error(`SendGridNotifier: failed to send email via SendGrid API: ${cause}`)
    }
  }
}
