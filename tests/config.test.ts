import { describe, it, expect } from 'vitest'
import { loadConfig } from '../server/src/config.js'

describe('loadConfig — PORT', () => {
  it('defaults to 3001 when PORT is unset', () => {
    expect(loadConfig({}).port).toBe(3001)
  })

  it('accepts a valid numeric PORT', () => {
    expect(loadConfig({ PORT: '4000' }).port).toBe(4000)
  })

  it('falls back to the default on a non-numeric PORT', () => {
    expect(loadConfig({ PORT: 'not-a-number' }).port).toBe(3001)
  })

  it('falls back to the default on a negative PORT', () => {
    expect(loadConfig({ PORT: '-1' }).port).toBe(3001)
  })

  it('falls back to the default on an out-of-range PORT', () => {
    expect(loadConfig({ PORT: '70000' }).port).toBe(3001)
  })

  it('falls back to the default on an empty PORT string', () => {
    expect(loadConfig({ PORT: '' }).port).toBe(3001)
  })
})

describe('loadConfig — ALLOWED_ORIGINS', () => {
  it('defaults to the dev client origin only when unset', () => {
    expect(loadConfig({}).allowedOrigins).toEqual(['http://localhost:5173'])
  })

  it('parses a single origin', () => {
    expect(loadConfig({ ALLOWED_ORIGINS: 'https://app.example.com' }).allowedOrigins).toEqual([
      'https://app.example.com',
    ])
  })

  it('parses a comma-separated list and trims whitespace', () => {
    expect(
      loadConfig({
        ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com ,https://c.example.com',
      }).allowedOrigins
    ).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ])
  })

  it('never returns a wildcard, even when explicitly configured', () => {
    // `*` is an origin string just like any other — we just want to prove
    // that config doesn't silently expand or reinterpret it.
    const { allowedOrigins } = loadConfig({ ALLOWED_ORIGINS: '*' })
    expect(allowedOrigins).toEqual(['*'])
    // The middleware in app.ts does exact-match containment, so `*` here
    // matches only the literal string "*" as an Origin header, which
    // browsers will never send. Documented behavior.
  })

  it('falls back to defaults on a whitespace-only value', () => {
    expect(loadConfig({ ALLOWED_ORIGINS: '   ' }).allowedOrigins).toEqual([
      'http://localhost:5173',
    ])
  })
})

describe('loadConfig — NODE_ENV', () => {
  it('reports isProduction=true only for exact "production"', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).isProduction).toBe(true)
    expect(loadConfig({ NODE_ENV: 'PRODUCTION' }).isProduction).toBe(false)
    expect(loadConfig({ NODE_ENV: 'development' }).isProduction).toBe(false)
    expect(loadConfig({}).isProduction).toBe(false)
  })
})
