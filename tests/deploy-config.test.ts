// Settings for hosted deployments: managed Postgres over TLS, small pools on a
// shared cluster, and Docker on a separate agent host over mutual TLS.

import { describe, it, expect } from 'vitest'
import { pgConfig, poolMax } from '../server/src/db/drivers'
import { dockerOptions } from '../server/src/services/dockerClient'
import { clientIpFromHeader } from '../server/src/app'
import { loadConfig } from '../server/src/config'
import type { Request, Response } from 'express'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'

describe('pgConfig', () => {
  const url = 'postgresql://routini:pw@private-db.example.com:25060/routini?sslmode=require'

  it('leaves the URL alone without a CA', () => {
    expect(pgConfig(url, {})).toEqual({ connectionString: url })
  })

  it('verifies against DATABASE_CA_CERT and drops sslmode so it cannot override the CA', () => {
    const cfg = pgConfig(url, { DATABASE_CA_CERT: `${PEM}\n` })
    expect(cfg.connectionString).toBe('postgresql://routini:pw@private-db.example.com:25060/routini')
    const ssl = cfg.ssl as { ca: string; rejectUnauthorized: boolean; checkServerIdentity: () => unknown }
    expect(ssl.ca).toBe(PEM)
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.checkServerIdentity()).toBeUndefined()
  })
})

describe('poolMax', () => {
  it('defaults to 10 and accepts a positive integer', () => {
    expect(poolMax({})).toBe(10)
    expect(poolMax({ ROUTINI_DB_POOL_MAX: '3' })).toBe(3)
    expect(poolMax({ ROUTINI_DB_POOL_MAX: '0' })).toBe(10)
    expect(poolMax({ ROUTINI_DB_POOL_MAX: 'lots' })).toBe(10)
  })
})

describe('dockerOptions', () => {
  const tls = { ROUTINI_DOCKER_TLS_CA: 'ca', ROUTINI_DOCKER_TLS_CERT: 'cert', ROUTINI_DOCKER_TLS_KEY: 'key' }

  it('uses Dockerode defaults (DOCKER_HOST, DOCKER_CERT_PATH) without PEM settings', () => {
    expect(dockerOptions({ DOCKER_HOST: 'tcp://10.0.0.5:2376' })).toBeUndefined()
  })

  it('builds a mutual-TLS client for a tcp:// agent host', () => {
    expect(dockerOptions({ ...tls, DOCKER_HOST: 'tcp://10.124.0.5:2376' })).toEqual({
      protocol: 'https',
      host: '10.124.0.5',
      port: 2376,
      ca: 'ca',
      cert: 'cert',
      key: 'key',
    })
  })

  it('refuses partial or misplaced TLS settings', () => {
    expect(() => dockerOptions({ ROUTINI_DOCKER_TLS_CA: 'ca', DOCKER_HOST: 'tcp://h:2376' })).toThrow(/must be set together/)
    expect(() => dockerOptions({ ...tls, DOCKER_HOST: 'unix:///var/run/docker.sock' })).toThrow(/tcp:\/\//)
  })
})

describe('clientIpFromHeader', () => {
  const run = (headers: Record<string, string>) => {
    const req = { ip: '10.0.0.2', get: (h: string) => headers[h.toLowerCase()] } as unknown as Request
    let called = false
    clientIpFromHeader('do-connecting-ip')(req, {} as Response, () => (called = true))
    expect(called).toBe(true)
    return req.ip
  }

  it('takes the client address from the edge header', () => {
    expect(run({ 'do-connecting-ip': ' 203.0.113.7 ' })).toBe('203.0.113.7')
    expect(run({ 'do-connecting-ip': '2001:db8::1' })).toBe('2001:db8::1')
  })

  it('keeps the trust-proxy address when the header is missing or not an address', () => {
    expect(run({})).toBe('10.0.0.2')
    expect(run({ 'do-connecting-ip': 'nonsense' })).toBe('10.0.0.2')
  })

  it('is read from ROUTINI_CLIENT_IP_HEADER', () => {
    expect(loadConfig({ NODE_ENV: 'test', ROUTINI_CLIENT_IP_HEADER: 'DO-Connecting-IP' }).clientIpHeader).toBe('do-connecting-ip')
    expect(loadConfig({ NODE_ENV: 'test' }).clientIpHeader).toBeUndefined()
  })
})
