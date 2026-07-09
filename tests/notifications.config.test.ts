/**
 * Tests for notification configuration loading and validation.
 */
import { describe, it, expect } from 'vitest'
import {
  loadNotificationConfig,
  validateNotificationConfig,
} from '../server/src/notifications/config.js'

describe('loadNotificationConfig', () => {
  it('returns disabled config when NOTIFY_PROVIDER is not set', () => {
    const config = loadNotificationConfig({})
    expect(config.provider).toBeUndefined()
  })

  it('returns disabled config when NOTIFY_PROVIDER is an unknown value', () => {
    const config = loadNotificationConfig({ NOTIFY_PROVIDER: 'slack' })
    expect(config.provider).toBeUndefined()
  })

  it('sets provider to smtp when NOTIFY_PROVIDER=smtp', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      SMTP_HOST: 'mail.example.com',
      SMTP_USER: 'user@example.com',
      SMTP_PASS: 'secret',
    })
    expect(config.provider).toBe('smtp')
  })

  it('sets provider to sendgrid when NOTIFY_PROVIDER=sendgrid', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'sendgrid',
      SENDGRID_API_KEY: 'SG.somekey',
    })
    expect(config.provider).toBe('sendgrid')
  })

  it('uses default fromEmail when NOTIFY_FROM_EMAIL is not set', () => {
    const config = loadNotificationConfig({ NOTIFY_PROVIDER: 'smtp' })
    expect(config.fromEmail).toBe('no-reply@routini.app')
  })

  it('uses custom fromEmail when NOTIFY_FROM_EMAIL is set', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      NOTIFY_FROM_EMAIL: 'alerts@myapp.com',
    })
    expect(config.fromEmail).toBe('alerts@myapp.com')
  })

  it('uses default fromName when NOTIFY_FROM_NAME is not set', () => {
    const config = loadNotificationConfig({ NOTIFY_PROVIDER: 'smtp' })
    expect(config.fromName).toBe('Routini')
  })

  it('sets defaultToEmail from NOTIFY_TO_EMAIL', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      NOTIFY_TO_EMAIL: 'admin@example.com',
    })
    expect(config.defaultToEmail).toBe('admin@example.com')
  })

  it('defaultToEmail is undefined when NOTIFY_TO_EMAIL is not set', () => {
    const config = loadNotificationConfig({ NOTIFY_PROVIDER: 'smtp' })
    expect(config.defaultToEmail).toBeUndefined()
  })

  describe('SMTP config', () => {
    it('populates smtp when provider is smtp', () => {
      const config = loadNotificationConfig({
        NOTIFY_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
      })
      expect(config.smtp).toEqual({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        user: 'user',
        password: 'pass',
      })
    })

    it('defaults smtp.port to 587 when SMTP_PORT is not set', () => {
      const config = loadNotificationConfig({
        NOTIFY_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
      })
      expect(config.smtp?.port).toBe(587)
    })

    it('defaults smtp.secure to false when SMTP_SECURE is not set', () => {
      const config = loadNotificationConfig({
        NOTIFY_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
      })
      expect(config.smtp?.secure).toBe(false)
    })

    it('smtp is undefined when provider is sendgrid', () => {
      const config = loadNotificationConfig({
        NOTIFY_PROVIDER: 'sendgrid',
        SENDGRID_API_KEY: 'SG.key',
      })
      expect(config.smtp).toBeUndefined()
    })
  })

  describe('SendGrid config', () => {
    it('sets sendgridApiKey when provider is sendgrid', () => {
      const config = loadNotificationConfig({
        NOTIFY_PROVIDER: 'sendgrid',
        SENDGRID_API_KEY: 'SG.abc123',
      })
      expect(config.sendgridApiKey).toBe('SG.abc123')
    })

    it('sendgridApiKey is undefined when provider is smtp', () => {
      const config = loadNotificationConfig({
        NOTIFY_PROVIDER: 'smtp',
        SMTP_HOST: 'h',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
      })
      expect(config.sendgridApiKey).toBeUndefined()
    })
  })
})

describe('validateNotificationConfig', () => {
  it('returns no errors when provider is undefined (disabled)', () => {
    const config = loadNotificationConfig({})
    expect(validateNotificationConfig(config)).toHaveLength(0)
  })

  it('returns no errors for a valid SMTP config', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      NOTIFY_FROM_EMAIL: 'noreply@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    })
    expect(validateNotificationConfig(config)).toHaveLength(0)
  })

  it('returns error when SMTP_HOST is missing', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      NOTIFY_FROM_EMAIL: 'noreply@example.com',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    })
    const errors = validateNotificationConfig(config)
    expect(errors.some((e) => e.includes('SMTP_HOST'))).toBe(true)
  })

  it('returns error when SMTP_USER is missing', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      NOTIFY_FROM_EMAIL: 'noreply@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PASS: 'pass',
    })
    const errors = validateNotificationConfig(config)
    expect(errors.some((e) => e.includes('SMTP_USER'))).toBe(true)
  })

  it('returns error when SMTP_PASS is missing', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'smtp',
      NOTIFY_FROM_EMAIL: 'noreply@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'user',
    })
    const errors = validateNotificationConfig(config)
    expect(errors.some((e) => e.includes('SMTP_PASS'))).toBe(true)
  })

  it('returns no errors for a valid SendGrid config', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'sendgrid',
      NOTIFY_FROM_EMAIL: 'noreply@example.com',
      SENDGRID_API_KEY: 'SG.key',
    })
    expect(validateNotificationConfig(config)).toHaveLength(0)
  })

  it('returns error when SENDGRID_API_KEY is missing', () => {
    const config = loadNotificationConfig({
      NOTIFY_PROVIDER: 'sendgrid',
      NOTIFY_FROM_EMAIL: 'noreply@example.com',
    })
    const errors = validateNotificationConfig(config)
    expect(errors.some((e) => e.includes('SENDGRID_API_KEY'))).toBe(true)
  })
})
