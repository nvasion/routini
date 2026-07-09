/**
 * Task outcome notifier.
 *
 * Subscribes to the task event bus and sends an email notification whenever a
 * task transitions to `succeeded` or `failed`. Notifications are "fire and
 * forget" — a delivery failure is logged server-side but never surfaces to the
 * task executor or the triggering HTTP request (which has already returned a
 * 202 Accepted by the time the task completes).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Recipient resolution
 * ─────────────────────────────────────────────────────────────────────────
 * The system stores a `username` per user, not a dedicated email address.
 * We treat the username as an email address if it contains an "@" sign,
 * otherwise we fall back to `defaultToEmail`. If neither resolves to a
 * deliverable address, the notification is skipped and a warning is logged
 * (without including the username in the log — it may be a display name, not
 * an email, and is therefore PII).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Lifecycle
 * ─────────────────────────────────────────────────────────────────────────
 * `TaskNotifier.start()` subscribes to the bus and returns an unsubscribe
 * function. Call it when the server shuts down (or in tests) to remove the
 * listener and prevent event leaks.
 */

import type { TaskStore } from '../tasks/store.js'
import type { UserStore } from '../auth/userStore.js'
import type { TaskEventSubscriber } from '../tasks/events.js'
import type { TaskRunEvent } from '../tasks/events.js'
import type { Notifier, NotificationMessage } from './types.js'

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Escape characters that have special meaning in HTML. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

interface MessageInput {
  taskName: string
  taskId: string
  status: 'succeeded' | 'failed'
  to: string
}

function buildMessage(input: MessageInput): NotificationMessage {
  const { taskName, taskId, status } = input
  const statusLabel = status === 'succeeded' ? 'succeeded ✓' : 'failed ✗'
  const subject = `Routini task "${taskName}" ${status}`

  const text = [
    `Your Routini task has ${status}.`,
    '',
    `Task:   ${taskName}`,
    `Status: ${status.toUpperCase()}`,
    `ID:     ${taskId}`,
    '',
    'Log in to Routini to view full execution details.',
  ].join('\n')

  const safeTaskName = escapeHtml(taskName)
  const safeTaskId = escapeHtml(taskId)
  const statusColor = status === 'succeeded' ? '#22c55e' : '#ef4444'

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#000;color:#fff;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#111;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#FF0000;padding:20px 32px;">
              <h1 style="margin:0;font-size:24px;color:#fff;letter-spacing:1px;">ROUTINI</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px;font-size:20px;color:#FFA500;">
                Task ${statusLabel}
              </h2>
              <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="padding:8px 0;color:#aaa;width:80px;">Task</td>
                  <td style="padding:8px 0;color:#fff;font-weight:bold;">${safeTaskName}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#aaa;">Status</td>
                  <td style="padding:8px 0;">
                    <span style="background:${statusColor};color:#fff;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:bold;text-transform:uppercase;">
                      ${escapeHtml(status)}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#aaa;">Task ID</td>
                  <td style="padding:8px 0;color:#888;font-size:13px;font-family:monospace;">${safeTaskId}</td>
                </tr>
              </table>
              <p style="margin:24px 0 0;color:#aaa;font-size:14px;">
                Log in to Routini to view full execution details and logs.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px;background:#0a0a0a;color:#555;font-size:12px;">
              You are receiving this notification because a task you own completed.
              This is an automated message — please do not reply.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { to: input.to, subject, text, html }
}

// ---------------------------------------------------------------------------
// TaskNotifier
// ---------------------------------------------------------------------------

export interface TaskNotifierOptions {
  /** Default recipient when the task owner's username is not an email address. */
  defaultToEmail?: string
}

export class TaskNotifier {
  private readonly notifier: Notifier
  private readonly taskStore: TaskStore
  private readonly userStore: UserStore
  private readonly defaultToEmail: string | undefined

  constructor(
    notifier: Notifier,
    taskStore: TaskStore,
    userStore: UserStore,
    options: TaskNotifierOptions = {},
  ) {
    this.notifier = notifier
    this.taskStore = taskStore
    this.userStore = userStore
    this.defaultToEmail = options.defaultToEmail
  }

  /**
   * Subscribe to `bus` and begin sending notifications. Returns an unsubscribe
   * function; call it when the server shuts down to remove the listener.
   */
  start(bus: TaskEventSubscriber): () => void {
    return bus.on((event: TaskRunEvent) => {
      if (event.type === 'task-status') {
        const { status } = event
        if (status === 'succeeded' || status === 'failed') {
          void this.handleTaskOutcome(event.taskId, status)
        }
      }
    })
  }

  private async handleTaskOutcome(
    taskId: string,
    status: 'succeeded' | 'failed',
  ): Promise<void> {
    const task = this.taskStore.getTask(taskId)
    if (!task) {
      // Task was deleted before the event was processed — skip silently.
      return
    }

    const recipient = this.resolveRecipient(task.userId)
    if (!recipient) {
      // No deliverable address found — log at warn level without including
      // the userId (it may be sensitive in a multi-tenant deployment).
      console.warn('[task-notifier] skipping notification: no recipient resolved', {
        taskId,
        status,
      })
      return
    }

    const msg = buildMessage({
      taskName: task.name,
      taskId: task.id,
      status,
      to: recipient,
    })

    try {
      await this.notifier.send(msg)
    } catch (err) {
      // Log without the recipient (PII) — just enough to diagnose transport
      // problems from the server log.
      console.error('[task-notifier] failed to send notification', {
        taskId,
        status,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Determine the notification recipient for a given user.
   *
   * Resolution order:
   *  1. If the user's username looks like an email address (contains "@"),
   *     use it directly.
   *  2. Fall back to `defaultToEmail` from config.
   *  3. Return undefined if neither resolves.
   */
  private resolveRecipient(userId: string): string | undefined {
    const user = this.userStore.findById(userId)
    if (user && looksLikeEmail(user.username)) {
      return user.username
    }
    return this.defaultToEmail
  }
}

/**
 * Minimal email format check. We deliberately keep this simple — the SMTP
 * server / SendGrid will reject truly malformed addresses, and a complex regex
 * introduces more attack surface than it prevents.
 */
function looksLikeEmail(value: string): boolean {
  const atIndex = value.indexOf('@')
  return atIndex > 0 && atIndex < value.length - 1
}
