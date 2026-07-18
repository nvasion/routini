/**
 * Notification Settings API
 *
 * Manages per-instance email notification preferences and provides a test
 * endpoint to validate SMTP connectivity.
 *
 * Routes:
 *   GET  /api/notifications/settings  – read current preferences
 *   PUT  /api/notifications/settings  – update preferences (CSRF required)
 *   POST /api/notifications/test      – send a test email  (CSRF required)
 *
 * SECURITY:
 *   – All write routes require a valid CSRF token (requireCsrf middleware).
 *   – SMTP credentials are never accepted from clients; they come exclusively
 *     from server environment variables.
 *   – Recipient email addresses are validated before use.
 *   – Transport errors are returned with generic messages; SMTP credentials or
 *     server internals are never leaked in responses.
 */

import { Router, Request, Response } from 'express'
import type { NotificationSettings } from '../types.js'
import {
  isValidEmail,
  sendTaskOutcomeNotification,
  createTransporter,
} from '../services/email.js'
import { requireCsrf } from './auth.js'

export const notificationsRouter = Router()

// ── In-memory store (skeleton – no persistence) ────────────────────────────────

export let notificationSettings: NotificationSettings = {
  enabled: false,
  recipientEmail: '',
  notifyOnSuccess: true,
  notifyOnFailure: true,
  notifyOnRoutineMilestone: false,
}

// ── GET /api/notifications/settings ──────────────────────────────────────────

notificationsRouter.get('/settings', (_req: Request, res: Response) => {
  res.json(notificationSettings)
})

// ── PUT /api/notifications/settings ──────────────────────────────────────────

notificationsRouter.put('/settings', requireCsrf, (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  const {
    enabled,
    recipientEmail,
    notifyOnSuccess,
    notifyOnFailure,
    notifyOnRoutineMilestone,
  } = body

  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' })
      return
    }
    notificationSettings = { ...notificationSettings, enabled }
  }

  if (recipientEmail !== undefined) {
    if (typeof recipientEmail !== 'string') {
      res.status(400).json({ error: 'recipientEmail must be a string' })
      return
    }
    const trimmed = recipientEmail.trim()
    // Allow clearing the address with an empty string; any non-empty value
    // must be a valid email address.
    if (trimmed !== '' && !isValidEmail(trimmed)) {
      res.status(400).json({ error: 'recipientEmail must be a valid email address' })
      return
    }
    notificationSettings = { ...notificationSettings, recipientEmail: trimmed }
  }

  if (notifyOnSuccess !== undefined) {
    if (typeof notifyOnSuccess !== 'boolean') {
      res.status(400).json({ error: 'notifyOnSuccess must be a boolean' })
      return
    }
    notificationSettings = { ...notificationSettings, notifyOnSuccess }
  }

  if (notifyOnFailure !== undefined) {
    if (typeof notifyOnFailure !== 'boolean') {
      res.status(400).json({ error: 'notifyOnFailure must be a boolean' })
      return
    }
    notificationSettings = { ...notificationSettings, notifyOnFailure }
  }

  if (notifyOnRoutineMilestone !== undefined) {
    if (typeof notifyOnRoutineMilestone !== 'boolean') {
      res.status(400).json({ error: 'notifyOnRoutineMilestone must be a boolean' })
      return
    }
    notificationSettings = { ...notificationSettings, notifyOnRoutineMilestone }
  }

  res.json(notificationSettings)
})

// ── POST /api/notifications/test ─────────────────────────────────────────────

/**
 * Sends a test notification to validate that the SMTP transport is reachable.
 *
 * Body (optional):
 *   { recipientEmail?: string }  – override for one-off test; falls back to
 *                                  the stored recipientEmail.
 *
 * Responses:
 *   200  – test email dispatched successfully
 *   400  – no valid recipient email available
 *   503  – SMTP_HOST not configured
 *   502  – SMTP transport error
 */
notificationsRouter.post('/test', requireCsrf, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>

  // Allow a one-shot override so users can test before persisting an address.
  const override =
    typeof body['recipientEmail'] === 'string' ? body['recipientEmail'].trim() : ''
  const targetEmail = override || notificationSettings.recipientEmail

  if (!isValidEmail(targetEmail)) {
    res
      .status(400)
      .json({ error: 'A valid recipientEmail is required to send a test notification' })
    return
  }

  const transporter = createTransporter()
  if (!transporter) {
    res.status(503).json({
      error: 'SMTP is not configured — set the SMTP_HOST environment variable to enable email',
    })
    return
  }

  try {
    await sendTaskOutcomeNotification(
      {
        taskId: 'test-notification',
        taskName: 'Test Notification',
        taskType: 'daily',
        status: 'succeeded',
        timestamp: new Date().toISOString(),
      },
      targetEmail,
      transporter,
    )
    res.json({ message: 'Test notification sent successfully', recipient: targetEmail })
  } catch (err) {
    // Log server-side for debugging; return only a generic message to the
    // client so that SMTP server responses (which may embed credentials) are
    // never forwarded to authenticated-but-unprivileged users.
    console.error('[notifications] Test email failed:', err)
    res.status(502).json({ error: 'Failed to send test notification' })
  }
})
