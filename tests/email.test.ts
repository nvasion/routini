/**
 * Unit tests for the email notification service.
 *
 * Coverage:
 *   – isValidEmail: happy paths, RFC edge cases, injection attempts
 *   – buildTaskOutcomeEmail: subject, text, HTML structure, HTML escaping (XSS)
 *   – sendTaskOutcomeNotification: null transporter no-op, invalid email error,
 *     successful dispatch, transport failure wrapping, credential safety
 */

import { describe, it, expect, vi } from 'vitest'
import {
  isValidEmail,
  buildTaskOutcomeEmail,
  sendTaskOutcomeNotification,
} from '../server/src/services/email'
import type { MailTransporter, TaskOutcomePayload } from '../server/src/services/email'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const successPayload: TaskOutcomePayload = {
  taskId: 'abc-123',
  taskName: 'Daily Health Check',
  taskType: 'daily',
  status: 'succeeded',
  timestamp: '2026-07-16T09:00:00.000Z',
}

const failurePayload: TaskOutcomePayload = {
  taskId: 'def-456',
  taskName: 'Code Review Bot',
  taskType: 'developmental',
  status: 'failed',
  timestamp: '2026-07-16T10:30:00.000Z',
  error: 'Container exited with code 1',
}

const routinePayload: TaskOutcomePayload = {
  taskId: 'ghi-789',
  taskName: 'Morning Workflow',
  taskType: 'routine',
  status: 'succeeded',
  timestamp: '2026-07-16T11:00:00.000Z',
}

/** Creates a mock transporter whose sendMail resolves successfully by default. */
function mockTransporter(
  impl: () => Promise<unknown> = () => Promise.resolve({ messageId: 'mock' }),
): MailTransporter {
  return { sendMail: vi.fn().mockImplementation(impl) } as unknown as MailTransporter
}

// ═════════════════════════════════════════════════════════════════════════════
// isValidEmail
// ═════════════════════════════════════════════════════════════════════════════

describe('isValidEmail', () => {
  // ── Happy paths ───────────────────────────────────────────────────────────

  it('accepts a standard email address', () => {
    expect(isValidEmail('user@example.com')).toBe(true)
  })

  it('accepts an email with a subdomain', () => {
    expect(isValidEmail('alert@mail.example.co.uk')).toBe(true)
  })

  it('accepts an email with plus-addressing', () => {
    expect(isValidEmail('user+tag@example.com')).toBe(true)
  })

  it('accepts an email with dots in the local part', () => {
    expect(isValidEmail('first.last@example.com')).toBe(true)
  })

  it('accepts an email with digits in local and domain', () => {
    expect(isValidEmail('user123@sub2.example.org')).toBe(true)
  })

  // ── Rejection cases ───────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    expect(isValidEmail('')).toBe(false)
  })

  it('rejects a plain string with no @', () => {
    expect(isValidEmail('notanemail')).toBe(false)
  })

  it('rejects a string with @ but no domain dot', () => {
    expect(isValidEmail('user@localhost')).toBe(false)
  })

  it('rejects missing local part', () => {
    expect(isValidEmail('@example.com')).toBe(false)
  })

  it('rejects multiple @ signs', () => {
    expect(isValidEmail('a@b@example.com')).toBe(false)
  })

  it('rejects addresses with embedded whitespace', () => {
    expect(isValidEmail('user @example.com')).toBe(false)
  })

  it('rejects addresses with tab characters', () => {
    expect(isValidEmail('user\t@example.com')).toBe(false)
  })

  it('rejects a local part exceeding 64 characters', () => {
    const local = 'a'.repeat(65)
    expect(isValidEmail(`${local}@example.com`)).toBe(false)
  })

  it('rejects total length exceeding 254 characters', () => {
    const local = 'a'.repeat(64)
    const domain = 'b'.repeat(190) + '.com' // > 254 total
    expect(isValidEmail(`${local}@${domain}`)).toBe(false)
  })

  it('rejects non-string inputs (number)', () => {
    expect(isValidEmail(42)).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidEmail(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isValidEmail(undefined)).toBe(false)
  })

  it('rejects an object', () => {
    expect(isValidEmail({})).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// buildTaskOutcomeEmail
// ═════════════════════════════════════════════════════════════════════════════

describe('buildTaskOutcomeEmail', () => {
  // ── Subject line ──────────────────────────────────────────────────────────

  it('includes the task name in the subject', () => {
    const { subject } = buildTaskOutcomeEmail(successPayload)
    expect(subject).toContain('Daily Health Check')
  })

  it('includes the status label in the subject', () => {
    const { subject } = buildTaskOutcomeEmail(successPayload)
    expect(subject).toContain('Succeeded')
  })

  it('shows "Failed" in the subject for a failed task', () => {
    const { subject } = buildTaskOutcomeEmail(failurePayload)
    expect(subject).toContain('Failed')
  })

  it('prefixes the subject with [Routini]', () => {
    const { subject } = buildTaskOutcomeEmail(successPayload)
    expect(subject.startsWith('[Routini]')).toBe(true)
  })

  // ── Plain-text body ───────────────────────────────────────────────────────

  it('text body contains the task name', () => {
    const { text } = buildTaskOutcomeEmail(successPayload)
    expect(text).toContain('Daily Health Check')
  })

  it('text body contains the task ID', () => {
    const { text } = buildTaskOutcomeEmail(successPayload)
    expect(text).toContain('abc-123')
  })

  it('text body contains the timestamp', () => {
    const { text } = buildTaskOutcomeEmail(successPayload)
    expect(text).toContain('2026-07-16T09:00:00.000Z')
  })

  it('text body contains the task type', () => {
    const { text } = buildTaskOutcomeEmail(successPayload)
    expect(text).toContain('daily')
  })

  it('text body includes the error field for failed tasks', () => {
    const { text } = buildTaskOutcomeEmail(failurePayload)
    expect(text).toContain('Container exited with code 1')
  })

  it('text body omits the error row when no error is present', () => {
    const { text } = buildTaskOutcomeEmail(successPayload)
    expect(text).not.toContain('Error:')
  })

  // ── HTML body ─────────────────────────────────────────────────────────────

  it('HTML body is valid HTML with a doctype', () => {
    const { html } = buildTaskOutcomeEmail(successPayload)
    expect(html.toLowerCase()).toContain('<!doctype html>')
  })

  it('HTML body contains the task name', () => {
    const { html } = buildTaskOutcomeEmail(successPayload)
    expect(html).toContain('Daily Health Check')
  })

  it('HTML body contains the task ID', () => {
    const { html } = buildTaskOutcomeEmail(successPayload)
    expect(html).toContain('abc-123')
  })

  it('HTML body omits the error row when no error is provided', () => {
    const { html } = buildTaskOutcomeEmail(successPayload)
    // The error row is not present for successful tasks
    expect(html).not.toContain('#fff3f3')
  })

  it('HTML body includes the error row for failed tasks', () => {
    const { html } = buildTaskOutcomeEmail(failurePayload)
    expect(html).toContain('Container exited with code 1')
    expect(html).toContain('#fff3f3') // error row background
  })

  // ── XSS prevention (HTML escaping) ───────────────────────────────────────

  it('escapes < in the task name to prevent XSS', () => {
    const xssPayload: TaskOutcomePayload = {
      ...successPayload,
      taskName: '<script>alert(1)</script>',
    }
    const { html } = buildTaskOutcomeEmail(xssPayload)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes & in the task name', () => {
    const payload: TaskOutcomePayload = {
      ...successPayload,
      taskName: 'Task & Routine',
    }
    const { html } = buildTaskOutcomeEmail(payload)
    expect(html).not.toContain('Task & Routine')
    expect(html).toContain('Task &amp; Routine')
  })

  it('escapes " in the error field', () => {
    const payload: TaskOutcomePayload = {
      ...failurePayload,
      error: 'Error: attribute="injected"',
    }
    const { html } = buildTaskOutcomeEmail(payload)
    expect(html).not.toContain('attribute="injected"')
    expect(html).toContain('attribute=&quot;injected&quot;')
  })

  it('escapes single quotes in the error field', () => {
    const payload: TaskOutcomePayload = {
      ...failurePayload,
      error: "It's broken",
    }
    const { html } = buildTaskOutcomeEmail(payload)
    expect(html).not.toContain("It's broken")
    expect(html).toContain('It&#39;s broken')
  })

  it('escapes > in the task ID field', () => {
    const payload: TaskOutcomePayload = {
      ...successPayload,
      taskId: 'id>evil',
    }
    const { html } = buildTaskOutcomeEmail(payload)
    expect(html).not.toContain('id>evil')
    expect(html).toContain('id&gt;evil')
  })

  // ── Routine task ──────────────────────────────────────────────────────────

  it('handles routine task type without error', () => {
    const { subject, text, html } = buildTaskOutcomeEmail(routinePayload)
    expect(subject).toContain('Morning Workflow')
    expect(text).toContain('routine')
    expect(html).toContain('Morning Workflow')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// sendTaskOutcomeNotification
// ═════════════════════════════════════════════════════════════════════════════

describe('sendTaskOutcomeNotification', () => {
  // ── Null transporter (SMTP not configured) ────────────────────────────────

  it('returns without sending when transporter is null', async () => {
    // Should resolve with no error even though there is no transport.
    await expect(
      sendTaskOutcomeNotification(successPayload, 'user@example.com', null),
    ).resolves.toBeUndefined()
  })

  it('does not call sendMail when transporter is null', async () => {
    const t = mockTransporter()
    await sendTaskOutcomeNotification(successPayload, 'user@example.com', null)
    // Passing null means the real transporter is bypassed; t.sendMail won't be called.
    expect(t.sendMail).not.toHaveBeenCalled()
  })

  // ── Email validation ──────────────────────────────────────────────────────

  it('throws for an invalid recipient email', async () => {
    const t = mockTransporter()
    await expect(
      sendTaskOutcomeNotification(successPayload, 'not-an-email', t),
    ).rejects.toThrow(/invalid recipient/i)
  })

  it('does not call sendMail when the recipient address is invalid', async () => {
    const t = mockTransporter()
    await expect(
      sendTaskOutcomeNotification(successPayload, 'bad', t),
    ).rejects.toThrow()
    expect(t.sendMail).not.toHaveBeenCalled()
  })

  it('throws for an empty recipient email', async () => {
    const t = mockTransporter()
    await expect(
      sendTaskOutcomeNotification(successPayload, '', t),
    ).rejects.toThrow(/invalid recipient/i)
  })

  // ── Successful dispatch ───────────────────────────────────────────────────

  it('calls sendMail with a valid recipient and resolves', async () => {
    const t = mockTransporter()
    await expect(
      sendTaskOutcomeNotification(successPayload, 'admin@example.com', t),
    ).resolves.toBeUndefined()
    expect(t.sendMail).toHaveBeenCalledOnce()
  })

  it('passes the correct recipient to sendMail', async () => {
    const t = mockTransporter()
    await sendTaskOutcomeNotification(successPayload, 'admin@example.com', t)
    const call = (t.sendMail as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      to: string
    }
    expect(call.to).toBe('admin@example.com')
  })

  it('passes a non-empty subject to sendMail', async () => {
    const t = mockTransporter()
    await sendTaskOutcomeNotification(successPayload, 'admin@example.com', t)
    const call = (t.sendMail as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      subject: string
    }
    expect(call.subject.length).toBeGreaterThan(0)
  })

  it('passes both text and html bodies to sendMail', async () => {
    const t = mockTransporter()
    await sendTaskOutcomeNotification(successPayload, 'admin@example.com', t)
    const call = (t.sendMail as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      text: string
      html: string
    }
    expect(call.text.length).toBeGreaterThan(0)
    expect(call.html.length).toBeGreaterThan(0)
  })

  it('uses SMTP_FROM env var as the from address', async () => {
    process.env['SMTP_FROM'] = 'alerts@myapp.com'
    const t = mockTransporter()
    await sendTaskOutcomeNotification(successPayload, 'user@example.com', t)
    const call = (t.sendMail as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      from: string
    }
    expect(call.from).toBe('alerts@myapp.com')
    delete process.env['SMTP_FROM']
  })

  it('falls back to noreply@routini.dev when SMTP_FROM is absent', async () => {
    delete process.env['SMTP_FROM']
    const t = mockTransporter()
    await sendTaskOutcomeNotification(successPayload, 'user@example.com', t)
    const call = (t.sendMail as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      from: string
    }
    expect(call.from).toBe('noreply@routini.dev')
  })

  // ── Transport failure handling ────────────────────────────────────────────

  it('wraps transport errors with context', async () => {
    const t = mockTransporter(() => Promise.reject(new Error('Connection refused')))
    await expect(
      sendTaskOutcomeNotification(successPayload, 'user@example.com', t),
    ).rejects.toThrow(/Failed to send task notification email/)
  })

  it('does not expose raw transport error details that might contain credentials', async () => {
    // SMTP server responses can embed credentials in error text (e.g.
    // "535 Authentication credentials invalid: apikey=SG.REAL_KEY").
    // The thrown error must use a generic message so that callers (including
    // API route handlers that surface errors to clients) never leak secrets.
    const sensitiveError = new Error('535 Authentication credentials invalid: apikey=SG.REAL_KEY')
    const t = mockTransporter(() => Promise.reject(sensitiveError))

    let caughtError: unknown
    try {
      await sendTaskOutcomeNotification(successPayload, 'user@example.com', t)
    } catch (e) {
      caughtError = e
    }

    expect(caughtError).toBeInstanceOf(Error)
    const msg = (caughtError as Error).message
    // Generic wrapper text is present
    expect(msg).toContain('Failed to send task notification email')
    // Raw SMTP credential detail must NOT appear
    expect(msg).not.toContain('SG.REAL_KEY')
    expect(msg).not.toContain('apikey')
    expect(msg).not.toContain('535 Authentication')
  })

  it('wraps non-Error transport rejections', async () => {
    const t = mockTransporter(() => Promise.reject('string error'))
    await expect(
      sendTaskOutcomeNotification(successPayload, 'user@example.com', t),
    ).rejects.toThrow(/Failed to send task notification email/)
  })

  // ── Failure payload ───────────────────────────────────────────────────────

  it('sends notifications for failed tasks', async () => {
    const t = mockTransporter()
    await expect(
      sendTaskOutcomeNotification(failurePayload, 'ops@example.com', t),
    ).resolves.toBeUndefined()
    expect(t.sendMail).toHaveBeenCalledOnce()
  })

  // ── Routine payload ───────────────────────────────────────────────────────

  it('sends notifications for routine completions', async () => {
    const t = mockTransporter()
    await expect(
      sendTaskOutcomeNotification(routinePayload, 'team@example.com', t),
    ).resolves.toBeUndefined()
    expect(t.sendMail).toHaveBeenCalledOnce()
  })
})
