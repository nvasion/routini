// Account emails (verification, password reset) with links into the console.
// SMTP is operator configuration (SMTP_* env, services/email.ts). Without it,
// development logs the link so you can click through, and production only notes
// that nothing was sent (links are credentials and don't belong in logs).

import type { AppContext } from './common.js'
import { issueAuthToken } from '../repos/authTokens.js'
import { createTransporter, sendAccountEmail, type AccountEmail } from '../services/email.js'

export interface AccountMail {
  /** Emails a fresh verification link. False when SMTP is not configured. */
  sendVerification(userId: string, email: string): Promise<boolean>
  /** Emails a fresh password-reset link. False when SMTP is not configured. */
  sendReset(userId: string, email: string): Promise<boolean>
}

export function accountMail(ctx: Pick<AppContext, 'db' | 'config' | 'mailer'>): AccountMail {
  const { db, config } = ctx
  const link = (path: string, token: string) => `${config.clientUrl}${path}?token=${encodeURIComponent(token)}`

  async function send(msg: AccountEmail): Promise<boolean> {
    const transporter = ctx.mailer === undefined ? createTransporter() : ctx.mailer
    if (!transporter) {
      if (config.env === 'production') console.warn(`[account] SMTP is not configured; "${msg.subject}" was not sent`)
      else console.log(`[account] SMTP is not configured. "${msg.subject}" for ${msg.to}: ${msg.url}`)
      return false
    }
    await sendAccountEmail(msg, transporter)
    return true
  }

  return {
    async sendVerification(userId, email) {
      const token = await issueAuthToken(db, userId, 'verify')
      return send({
        to: email,
        subject: 'Verify your email for Routini',
        intro: 'Confirm this address to run agents and start environments on Routini.',
        action: 'Verify email',
        url: link('/verify-email', token),
        outro: "If you didn't create a Routini account, ignore this email.",
      })
    },
    async sendReset(userId, email) {
      const token = await issueAuthToken(db, userId, 'reset')
      return send({
        to: email,
        subject: 'Reset your Routini password',
        intro: 'Someone asked to reset the password for this Routini account. The link works once, for 30 minutes.',
        action: 'Choose a new password',
        url: link('/reset-password', token),
        outro: "If it wasn't you, ignore this email; your password stays the same.",
      })
    },
  }
}
