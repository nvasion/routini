/**
 * SMTP notifier — delivers `NotificationMessage` via nodemailer.
 *
 * Works with any RFC-5321-compliant SMTP server, including:
 *  - Self-hosted Postfix / Exim
 *  - Gmail relay (smtp.gmail.com:587 / STARTTLS)
 *  - SendGrid SMTP relay (smtp.sendgrid.net:587, password = API key)
 *  - Mailtrap / MailHog for local development
 *
 * SECURITY:
 *  - SMTP credentials live only in the transporter config and are never
 *    serialized, logged, or returned via any API surface.
 *  - `SmtpNotifier` validates the provided config up-front and throws at
 *    construction time rather than silently doing nothing.
 */

import nodemailer, { type Transporter } from 'nodemailer'
import type { SmtpConfig } from './config.js'
import type { Notifier, NotificationMessage } from './types.js'

export class SmtpNotifier implements Notifier {
  private readonly transporter: Transporter
  private readonly fromEmail: string
  private readonly fromName: string

  constructor(smtp: SmtpConfig, fromEmail: string, fromName: string) {
    if (!smtp.host) throw new Error('SmtpNotifier: smtp.host is required')
    if (!smtp.user) throw new Error('SmtpNotifier: smtp.user is required')
    if (!smtp.password) throw new Error('SmtpNotifier: smtp.password is required')
    if (!fromEmail) throw new Error('SmtpNotifier: fromEmail is required')

    this.fromEmail = fromEmail
    this.fromName = fromName

    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: {
        user: smtp.user,
        pass: smtp.password,
      },
    })
  }

  async send(msg: NotificationMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      })
    } catch (err) {
      // Wrap with context but do NOT include the recipient address or message
      // body in the error message — those are PII.
      const cause = err instanceof Error ? err.message : String(err)
      throw new Error(`SmtpNotifier: failed to send email via SMTP: ${cause}`)
    }
  }
}
