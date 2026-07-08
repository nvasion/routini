import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  loadAuthConfig,
} from '../server/src/auth/config.js'

describe('loadAuthConfig', () => {
  it('applies the development fallback secret when JWT_SECRET is unset', () => {
    const config = loadAuthConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
    expect(config.jwtSecret.length).toBeGreaterThanOrEqual(32)
    expect(config.cookieSecure).toBe(false)
  })

  it('throws in production when JWT_SECRET is missing or too short', () => {
    expect(() =>
      loadAuthConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/JWT_SECRET/)

    expect(() =>
      loadAuthConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/at least 32/)
  })

  it('uses provided secret and marks cookies Secure in production', () => {
    const config = loadAuthConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(64),
      DEFAULT_ADMIN_PASSWORD: 'a-real-password',
    } as NodeJS.ProcessEnv)
    expect(config.jwtSecret).toBe('x'.repeat(64))
    expect(config.cookieSecure).toBe(true)
  })

  it('parses JWT_TTL_SECONDS and falls back on invalid values', () => {
    const custom = loadAuthConfig({
      NODE_ENV: 'development',
      JWT_TTL_SECONDS: '120',
    } as NodeJS.ProcessEnv)
    expect(custom.tokenTtlSeconds).toBe(120)

    const invalid = loadAuthConfig({
      NODE_ENV: 'development',
      JWT_TTL_SECONDS: 'not-a-number',
    } as NodeJS.ProcessEnv)
    expect(invalid.tokenTtlSeconds).toBe(DEFAULT_TOKEN_TTL_SECONDS)

    const zero = loadAuthConfig({
      NODE_ENV: 'development',
      JWT_TTL_SECONDS: '0',
    } as NodeJS.ProcessEnv)
    expect(zero.tokenTtlSeconds).toBe(DEFAULT_TOKEN_TTL_SECONDS)
  })

  it('caps JWT_TTL_SECONDS at MAX_TOKEN_TTL_SECONDS so a typo cannot yield a year-long session', () => {
    const config = loadAuthConfig({
      NODE_ENV: 'development',
      JWT_TTL_SECONDS: String(MAX_TOKEN_TTL_SECONDS * 10),
    } as NodeJS.ProcessEnv)
    expect(config.tokenTtlSeconds).toBe(MAX_TOKEN_TTL_SECONDS)
  })

  it('exposes trimmed default admin credentials', () => {
    const config = loadAuthConfig({
      NODE_ENV: 'development',
      DEFAULT_ADMIN_USERNAME: '  root  ',
      DEFAULT_ADMIN_PASSWORD: '  secret  ',
    } as NodeJS.ProcessEnv)
    expect(config.defaultUsername).toBe('root')
    expect(config.defaultPassword).toBe('secret')
  })

  it('refuses the default "changeme" admin password in production', () => {
    // Unset — falls through to the sentinel default.
    expect(() =>
      loadAuthConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(64),
      } as NodeJS.ProcessEnv),
    ).toThrow(/DEFAULT_ADMIN_PASSWORD/)

    // Explicitly the sentinel value.
    expect(() =>
      loadAuthConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(64),
        DEFAULT_ADMIN_PASSWORD: 'changeme',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DEFAULT_ADMIN_PASSWORD/)
  })

  it('reads USER_STORE_PATH and rejects relative paths', () => {
    const config = loadAuthConfig({
      NODE_ENV: 'development',
      USER_STORE_PATH: '/var/lib/routini/users.json',
    } as NodeJS.ProcessEnv)
    expect(config.userStorePath).toBe('/var/lib/routini/users.json')

    expect(() =>
      loadAuthConfig({
        NODE_ENV: 'development',
        USER_STORE_PATH: 'relative/users.json',
      } as NodeJS.ProcessEnv),
    ).toThrow(/absolute path/)
  })

  it('parses rate limit env vars and applies safe defaults', () => {
    const defaults = loadAuthConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
    expect(defaults.loginMaxAttempts).toBeGreaterThan(0)
    expect(defaults.loginWindowSeconds).toBeGreaterThan(0)

    const custom = loadAuthConfig({
      NODE_ENV: 'development',
      LOGIN_RATE_LIMIT_MAX: '3',
      LOGIN_RATE_LIMIT_WINDOW_SECONDS: '30',
    } as NodeJS.ProcessEnv)
    expect(custom.loginMaxAttempts).toBe(3)
    expect(custom.loginWindowSeconds).toBe(30)
  })
})
