/**
 * Email Notification Service
 *
 * Sends task-outcome notifications via SMTP (including SendGrid's SMTP relay).
 * Configuration is loaded exclusively from environment variables — no secrets
 * are accepted through any user-facing API.
 *
 * SECURITY:
 *   – SMTP credentials live only in environment variables; never in logs or
 *     error messages exposed to the client.
 *   – Email content is HTML-escaped before being placed inside the HTML body
 *     to prevent stored-XSS in email clients that render HTML.
 *   – Recipient addresses are validated before the transport is opened.
 */

import nodemailer from 'nodemailer'
import type { Transporter, SentMessageInfo } from 'nodemailer'
import type { TaskStatus, TaskType } from '../types.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal transporter interface, satisfied by a real nodemailer Transporter
 * and easily replaced with a mock in unit tests.
 */
export interface MailTransporter {
  sendMail(options: {
    from: string
    to: string
    subject: string
    text: string
    html: string
  }): Promise<SentMessageInfo>
}

export interface TaskOutcomePayload {
  taskId: string
  taskName: string
  taskType: TaskType
  status: TaskStatus
  timestamp: string
  /** Optional human-readable error detail. Must not contain secrets or PII. */
  error?: string
}

// ── Email address validation ───────────────────────────────────────────────────

/**
 * Validates an email address.
 *   – Must be a non-empty string
 *   – Total length ≤ 254 characters (RFC 5321)
 *   – Local part ≤ 64 characters (RFC 5321)
 *   – Must contain exactly one '@' with non-empty parts on each side
 */
export function isValidEmail(value: unknown): value is string {
  if (!value || typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length > 254) return false

  const atIdx = trimmed.indexOf('@')
  if (atIdx < 1) return false                     // nothing before '@'
  const local = trimmed.slice(0, atIdx)
  const domain = trimmed.slice(atIdx + 1)
  if (!local || local.length > 64) return false
  if (!domain || domain.indexOf('@') !== -1) return false  // multiple '@'
  if (!domain.includes('.')) return false          // domain must have a dot

  // Reject whitespace anywhere in the address
  if (/\s/.test(trimmed)) return false

  return true
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, ch => HTML_ESCAPE[ch] ?? ch)
}

// ── Transport factory ─────────────────────────────────────────────────────────

/**
 * Builds a nodemailer transporter from environment variables.
 *
 * | Variable    | Description                                | Default             |
 * |-------------|--------------------------------------------|---------------------|
 * | SMTP_HOST   | Mail server hostname (required)            | —                   |
 * | SMTP_PORT   | Port                                       | 587                 |
 * | SMTP_SECURE | "true" for TLS (port 465); else STARTTLS   | false               |
 * | SMTP_USER   | Auth username / SendGrid "apikey" literal  | —                   |
 * | SMTP_PASS   | Auth password / SendGrid API key           | —                   |
 * | SMTP_FROM   | Envelope From address                      | noreply@routini.dev |
 *
 * For SendGrid SMTP relay:
 *   SMTP_HOST=smtp.sendgrid.net, SMTP_PORT=587,
 *   SMTP_USER=apikey, SMTP_PASS=<your-sendgrid-api-key>
 *
 * Returns `null` when SMTP_HOST is absent (silent no-op mode).
 */
export function createTransporter(): MailTransporter | null {
  const host = process.env['SMTP_HOST']
  if (!host) return null

  const port = parseInt(process.env['SMTP_PORT'] ?? '587', 10)
  const secure = process.env['SMTP_SECURE'] === 'true'
  const user = process.env['SMTP_USER'] ?? ''
  const pass = process.env['SMTP_PASS'] ?? ''

  const transporter: Transporter<SentMessageInfo> = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  })

  return transporter
}

// ── Email builders ────────────────────────────────────────────────────────────

const STATUS_DISPLAY: Record<string, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  queued: 'Queued',
  running: 'Running',
  idle: 'Idle',
}

const STATUS_COLOR: Record<string, string> = {
  succeeded: '#2e7d32',
  failed: '#cc0000',
}

/**
 * Builds the plain-text and HTML body for a task outcome notification.
 * All user-supplied strings are HTML-escaped to prevent XSS.
 *
 * @returns subject, text (plain), and html body strings.
 */
export function buildTaskOutcomeEmail(payload: TaskOutcomePayload): {
  subject: string
  text: string
  html: string
} {
  const statusLabel = STATUS_DISPLAY[payload.status] ?? payload.status
  const subject = `[Routini] Task "${payload.taskName}" ${statusLabel}`

  // Plain-text version — no escaping needed
  const textLines = [
    `Task Notification — ${statusLabel}`,
    '',
    `Task:      ${payload.taskName}`,
    `Type:      ${payload.taskType}`,
    `Status:    ${payload.status}`,
    `Task ID:   ${payload.taskId}`,
    `Timestamp: ${payload.timestamp}`,
  ]
  if (payload.error) {
    textLines.push(`Error:     ${payload.error}`)
  }
  textLines.push('', 'This is an automated notification from Routini.')
  const text = textLines.join('\n')

  // HTML version — all values escaped
  const safe = {
    name: escapeHtml(payload.taskName),
    type: escapeHtml(payload.taskType),
    status: escapeHtml(statusLabel),
    id: escapeHtml(payload.taskId),
    ts: escapeHtml(payload.timestamp),
    error: payload.error ? escapeHtml(payload.error) : null,
  }

  const statusColor = STATUS_COLOR[payload.status] ?? '#333333'
  const headerColor = payload.status === 'failed' ? '#cc0000' : '#b85c00'

  const errorRow = safe.error
    ? `<tr style="background:#fff3f3">
        <td style="padding:8px 12px;font-weight:600;color:#cc0000;width:110px">Error</td>
        <td style="padding:8px 12px;color:#cc0000;font-family:monospace;word-break:break-all">${safe.error}</td>
       </tr>`
    : ''

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;background:#f9f9f9">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12)">
    <div style="background:${headerColor};padding:20px 24px">
      <h1 style="margin:0;font-size:20px;color:#fff;letter-spacing:.3px">Routini Task Notification</h1>
    </div>
    <div style="padding:24px">
      <table style="border-collapse:collapse;width:100%">
        <tr>
          <td style="padding:8px 12px;font-weight:600;width:110px">Task</td>
          <td style="padding:8px 12px">${safe.name}</td>
        </tr>
        <tr style="background:#f5f5f5">
          <td style="padding:8px 12px;font-weight:600">Type</td>
          <td style="padding:8px 12px;text-transform:capitalize">${safe.type}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600">Status</td>
          <td style="padding:8px 12px;font-weight:700;color:${statusColor}">${safe.status}</td>
        </tr>
        <tr style="background:#f5f5f5">
          <td style="padding:8px 12px;font-weight:600">Task ID</td>
          <td style="padding:8px 12px;font-family:monospace;font-size:13px">${safe.id}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600">Timestamp</td>
          <td style="padding:8px 12px">${safe.ts}</td>
        </tr>
        ${errorRow}
      </table>
    </div>
    <div style="padding:12px 24px 20px;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#888">
        This is an automated notification from Routini. Do not reply to this message.
      </p>
    </div>
  </div>
</body>
</html>`

  return { subject, text, html }
}

// ── Notification sender ────────────────────────────────────────────────────────

/**
 * Sends a task outcome notification email.
 *
 * Silent no-ops:
 *   – `transporter` is `null` (SMTP not configured).
 *
 * Thrown errors:
 *   – `recipientEmail` is not a valid address.
 *   – The SMTP transport fails. The error message includes context but
 *     NEVER includes SMTP credentials or the raw transport error detail.
 *
 * @param payload    Task outcome information for the email body.
 * @param recipientEmail  Destination address (validated before use).
 * @param transporter  Nodemailer transporter; defaults to `createTransporter()`.
 *                     Pass a mock in unit tests.
 */
export async function sendTaskOutcomeNotification(
  payload: TaskOutcomePayload,
  recipientEmail: string,
  transporter: MailTransporter | null = createTransporter(),
): Promise<void> {
  if (!transporter) return // SMTP not configured — silent no-op

  if (!isValidEmail(recipientEmail)) {
    throw new Error('Invalid recipient email address')
  }

  const from = process.env['SMTP_FROM'] ?? 'noreply@routini.dev'
  const { subject, text, html } = buildTaskOutcomeEmail(payload)

  try {
    await transporter.sendMail({ from, to: recipientEmail, subject, text, html })
  } catch (err) {
    // Log the full error server-side for debugging, but NEVER include the raw
    // transport error in the thrown message — SMTP server responses can contain
    // credentials (e.g. "535 … apikey=SG.xxx") that must not reach clients.
    console.error('[email] Transport error sending task notification:', err)
    throw new Error('Failed to send task notification email')
  }
}
