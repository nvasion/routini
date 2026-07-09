/**
 * Tests for SmtpNotifier and SendGridNotifier construction-time validation.
 *
 * We don't test actual email delivery (that would require a live SMTP server
 * or SendGrid account). Instead we verify:
 *  - Construction fails fast when required config is missing.
 *  - `send()` wraps transport errors with context (no PII in the error).
 *
 * For SMTP we stub the underlying nodemailer transporter.
 * For SendGrid we stub the @sendgrid/mail module via vi.mock.
 */
import { describe, it, expect, vi } from 'vitest'

// Mock @sendgrid/mail before it is imported so the SendGridNotifier receives
// the stub. vitest hoists vi.mock() calls to the top of the module.
vi.mock('@sendgrid/mail', () => ({
  default: {
    setApiKey: vi.fn(),
    send: vi.fn(),
  },
}))

import { SmtpNotifier } from '../server/src/notifications/smtpNotifier.js'
import { SendGridNotifier } from '../server/src/notifications/sendgridNotifier.js'
import { createNotifier, loadNotificationConfig } from '../server/src/notifications/index.js'
import sgMail from '@sendgrid/mail'

// ---------------------------------------------------------------------------
// SmtpNotifier
// ---------------------------------------------------------------------------

describe('SmtpNotifier', () => {
  const validSmtp = {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'user@example.com',
    password: 'secret',
  }

  it('constructs successfully with valid config', () => {
    expect(
      () => new SmtpNotifier(validSmtp, 'from@example.com', 'Test'),
    ).not.toThrow()
  })

  it('throws when host is empty', () => {
    expect(
      () => new SmtpNotifier({ ...validSmtp, host: '' }, 'from@example.com', 'Test'),
    ).toThrow('SmtpNotifier: smtp.host is required')
  })

  it('throws when user is empty', () => {
    expect(
      () => new SmtpNotifier({ ...validSmtp, user: '' }, 'from@example.com', 'Test'),
    ).toThrow('SmtpNotifier: smtp.user is required')
  })

  it('throws when password is empty', () => {
    expect(
      () =>
        new SmtpNotifier({ ...validSmtp, password: '' }, 'from@example.com', 'Test'),
    ).toThrow('SmtpNotifier: smtp.password is required')
  })

  it('throws when fromEmail is empty', () => {
    expect(
      () => new SmtpNotifier(validSmtp, '', 'Test'),
    ).toThrow('SmtpNotifier: fromEmail is required')
  })

  it('wraps sendMail errors with context (no PII)', async () => {
    // Create notifier with valid config; stub the underlying transporter.
    const notifier = new SmtpNotifier(validSmtp, 'from@example.com', 'Test')
    // Access private transporter to inject the stub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transporterStub = { sendMail: vi.fn().mockRejectedValue(new Error('Connection refused')) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(notifier as any).transporter = transporterStub

    const msg = {
      to: 'recipient@example.com',
      subject: 'Test',
      text: 'body',
      html: '<p>body</p>',
    }

    await expect(notifier.send(msg)).rejects.toThrow(
      'SmtpNotifier: failed to send email via SMTP: Connection refused',
    )
    // The recipient address must not appear in the error message.
    await notifier.send(msg).catch((err: Error) => {
      expect(err.message).not.toContain('recipient@example.com')
    })
  })
})

// ---------------------------------------------------------------------------
// SendGridNotifier
// ---------------------------------------------------------------------------

describe('SendGridNotifier', () => {
  it('constructs successfully with valid config', () => {
    expect(
      () => new SendGridNotifier('SG.key', 'from@example.com', 'Test'),
    ).not.toThrow()
  })

  it('throws when apiKey is empty', () => {
    expect(
      () => new SendGridNotifier('', 'from@example.com', 'Test'),
    ).toThrow('SendGridNotifier: apiKey is required')
  })

  it('throws when fromEmail is empty', () => {
    expect(
      () => new SendGridNotifier('SG.key', '', 'Test'),
    ).toThrow('SendGridNotifier: fromEmail is required')
  })

  it('wraps send errors with context (no PII)', async () => {
    const notifier = new SendGridNotifier('SG.key', 'from@example.com', 'Test')

    // Make the stubbed sgMail.send reject for this test
    vi.mocked(sgMail.send).mockRejectedValue(new Error('Unauthorized'))

    const msg = {
      to: 'recipient@example.com',
      subject: 'Test',
      text: 'body',
      html: '<p>body</p>',
    }

    await expect(notifier.send(msg)).rejects.toThrow(
      'SendGridNotifier: failed to send email via SendGrid API: Unauthorized',
    )
    // Also confirm the error does not leak the recipient address (PII guard)
    await notifier.send(msg).catch((err: Error) => {
      expect(err.message).not.toContain('recipient@example.com')
    })
  })
})

// ---------------------------------------------------------------------------
// createNotifier factory
// ---------------------------------------------------------------------------

describe('createNotifier', () => {
  it('returns undefined when provider is not set', () => {
    const config = loadNotificationConfig({})
    expect(createNotifier(config)).toBeUndefined()
  })

  it('returns SmtpNotifier for smtp provider', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      NOTIFY_FROM_EMAIL: 'from@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    })
    const notifier = createNotifier(config)
    expect(notifier).toBeInstanceOf(SmtpNotifier)
  })

  it('returns SendGridNotifier for sendgrid provider', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'sendgrid',
      NOTIFY_FROM_EMAIL: 'from@example.com',
      SENDGRID_API_KEY: 'SG.key',
    })
    const notifier = createNotifier(config)
    expect(notifier).toBeInstanceOf(SendGridNotifier)
  })

  it('throws when smtp provider is missing smtp config fields', () => {
    // Manually craft a config with provider set but smtp undefined
    expect(() =>
      createNotifier({
        provider: 'smtp',
        fromEmail: 'from@example.com',
        fromName: 'Test',
        defaultToEmail: undefined,
        smtp: undefined,
        sendgridApiKey: undefined,
      }),
    ).toThrow('createNotifier: SMTP provider selected but smtp config is missing')
  })

  it('throws when sendgrid provider is missing API key', () => {
    expect(() =>
      createNotifier({
        provider: 'sendgrid',
        fromEmail: 'from@example.com',
        fromName: 'Test',
        defaultToEmail: undefined,
        smtp: undefined,
        sendgridApiKey: '',
      }),
    ).toThrow('createNotifier: SendGrid provider selected but SENDGRID_API_KEY is missing')
  })
})
