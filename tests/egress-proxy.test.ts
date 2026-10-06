// Egress proxy: session auth, allow-list, tunnel vs intercept, credential
// injection per binding format, control API. All in-process: a local HTTPS
// "upstream" stands in for api.github.com & co.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net, { type AddressInfo } from 'node:net'
import { EgressProxy } from '../server/src/egress/proxy'
import { generateCa, LeafIssuer } from '../server/src/egress/ca'
import { PLACEHOLDER, type EgressSession } from '../server/src/egress/types'

const SECRET = 'control-secret-0123456789'
const routiniCa = generateCa('Routini Test CA')
const upstreamCa = generateCa('Upstream Test CA')
const upstreamIssuer = new LeafIssuer(upstreamCa)

let upstream: https.Server
let plain: http.Server
let proxy: EgressProxy
let ports: { proxyPort: number; controlPort: number }
let upstreamPort: number
let plainPort: number

const session = (token: string, over: Partial<EgressSession> = {}): EgressSession => ({
  token,
  orgId: 'org-1',
  label: 'run-1',
  allowedHosts: ['api.github.com', 'github.com', 'tunnel.example', 'api.anthropic.com', 'plain.example'],
  bindings: [
    { host: 'api.github.com', header: 'authorization', format: 'bearer', secret: 'ghp_REAL_api' },
    { host: 'github.com', header: 'authorization', format: 'basic-token', secret: 'ghp_REAL_git' },
    { host: 'api.anthropic.com', header: 'x-api-key', format: 'raw', secret: 'sk-ant-REAL' },
  ],
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
})

async function control(method: string, path: string, body?: unknown, secret = SECRET) {
  const res = await fetch(`http://127.0.0.1:${ports.controlPort}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** Makes an HTTPS request to `host` through the proxy, trusting only `trust`. */
function viaProxy(host: string, token: string | null, trust: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; connectStatus?: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: ports.proxyPort,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: token ? { 'proxy-authorization': `Basic ${Buffer.from(`routini:${token}`).toString('base64')}` } : {},
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        resolve({ status: 0, body: '', connectStatus: res.statusCode })
        return
      }
      const s = tls.connect({ socket, servername: host, ca: [trust] }, () => {
        const r = https.request({ createConnection: () => s, host, path: '/echo', method: 'GET', headers: { ...headers, host } }, (resp) => {
          let body = ''
          resp.on('data', (c) => (body += c))
          resp.on('end', () => resolve({ status: resp.statusCode ?? 0, body }))
        })
        r.on('error', reject)
        r.end()
      })
      s.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

/** Sends a raw CONNECT and returns the proxy's reply head and body, read until the proxy closes. */
function rawConnect(target: string, token: string | null): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(ports.proxyPort, '127.0.0.1', () => {
      const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`routini:${token}`).toString('base64')}\r\n` : ''
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
    })
    let raw = ''
    s.on('data', (c) => (raw += c))
    s.on('error', reject)
    s.on('close', () => {
      const [head = '', body = ''] = raw.split('\r\n\r\n')
      const [statusLine = '', ...lines] = head.split('\r\n')
      const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]))
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body })
    })
  })
}

beforeAll(async () => {
  upstream = https.createServer({ SNICallback: (name, cb) => cb(null, upstreamIssuer.contextFor(name)) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ host: req.headers.host, authorization: req.headers['authorization'] ?? null, xApiKey: req.headers['x-api-key'] ?? null }))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = (upstream.address() as AddressInfo).port
  plain = http.createServer((req, res) => res.end(JSON.stringify({ authorization: req.headers['authorization'] ?? null, path: req.url })))
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
  plainPort = (plain.address() as AddressInfo).port
  proxy = new EgressProxy({
    secret: SECRET,
    ca: routiniCa,
    upstreamCa: [upstreamCa.certPem],
    // down.example points at a port nothing listens on (1 is privileged and unused here).
    resolve: (host, port) => ({ host: '127.0.0.1', port: host === 'plain.example' ? plainPort : host === 'down.example' ? 1 : port === 443 ? upstreamPort : port }),
    log: () => {},
  })
  ports = await proxy.listen(0, 0, '127.0.0.1')
})

afterAll(async () => {
  await proxy.close()
  await new Promise((r) => upstream.close(r))
  await new Promise((r) => plain.close(r))
})

describe('control API', () => {
  it('requires the secret and validates sessions', async () => {
    expect((await control('GET', '/ca', undefined, 'wrong')).status).toBe(401)
    const ca = await control('GET', '/ca')
    expect(ca.body.pem).toBe(routiniCa.certPem)
    expect((await control('PUT', '/sessions/aaaaaaaaaaaaaaaa', { token: 'mismatch' })).status).toBe(400)
    expect((await control('PUT', '/sessions/aaaaaaaaaaaaaaaa', session('aaaaaaaaaaaaaaaa'))).status).toBe(200)
    expect((await control('GET', '/sessions/aaaaaaaaaaaaaaaa/stats')).body).toEqual({ requests: 0, intercepted: 0, blocked: [] })
    expect((await control('DELETE', '/sessions/aaaaaaaaaaaaaaaa')).status).toBe(200)
    expect((await control('DELETE', '/sessions/aaaaaaaaaaaaaaaa')).status).toBe(404)
  })
})

describe('proxying', () => {
  const token = 'b'.repeat(32)
  beforeAll(async () => {
    await control('PUT', `/sessions/${token}`, session(token))
  })

  it('demands a valid session', async () => {
    expect((await viaProxy('api.github.com', null, routiniCa.certPem)).connectStatus).toBe(407)
    expect((await viaProxy('api.github.com', 'c'.repeat(32), routiniCa.certPem)).connectStatus).toBe(407)
  })

  // libcurl with CURLAUTH_ANY (git's default) sends CONNECT without credentials,
  // and retries with them only if the 407 is a complete response. Before this
  // was length-delimited, git failed every clone with "Proxy CONNECT aborted".
  it('answers refusals with complete responses, so challenge-first clients can retry', async () => {
    const challenge = await rawConnect('github.com:443', null)
    expect(challenge.status).toBe(407)
    expect(challenge.headers['proxy-authenticate']).toBe('Basic realm="routini"')
    expect(challenge.headers['content-length']).toBe('0')
    expect(challenge.headers['connection']).toBe('close')

    const blocked = await rawConnect('evil.example:443', token)
    expect(blocked.status).toBe(403)
    expect(Number(blocked.headers['content-length'])).toBe(Buffer.byteLength(blocked.body))
    expect(blocked.body).toContain('evil.example is blocked by Routini egress policy')

    // The retry, on a new connection with credentials, gets its tunnel.
    const r = await viaProxy('tunnel.example', token, upstreamCa.certPem)
    expect(r.status).toBe(200)
  })

  it('reports an unreachable upstream as a complete 502', async () => {
    await control('PUT', `/sessions/${token}`, session(token, { allowedHosts: [...session(token).allowedHosts, 'down.example'] }))
    const r = await rawConnect('down.example:443', token)
    expect(r.status).toBe(502)
    expect(Number(r.headers['content-length'])).toBe(Buffer.byteLength(r.body))
    expect(r.body).toContain('could not reach down.example:443')
  })

  it('blocks hosts that are not allowed and reports them', async () => {
    expect((await viaProxy('evil.example', token, routiniCa.certPem)).connectStatus).toBe(403)
    expect((await control('GET', `/sessions/${token}/stats`)).body.blocked).toContain('evil.example')
  })

  it('tunnels allowed hosts without bindings: the client sees the real certificate and its own headers', async () => {
    const r = await viaProxy('tunnel.example', token, upstreamCa.certPem, { authorization: 'Bearer mine' })
    expect(JSON.parse(r.body)).toEqual({ host: 'tunnel.example', authorization: 'Bearer mine', xApiKey: null })
    // A client that trusts only Routini's CA cannot complete TLS: the proxy did not intercept.
    await expect(viaProxy('tunnel.example', token, routiniCa.certPem)).rejects.toThrow()
  })

  it('intercepts bound hosts and swaps placeholders for real credentials', async () => {
    const api = JSON.parse((await viaProxy('api.github.com', token, routiniCa.certPem, { authorization: `Bearer ${PLACEHOLDER}` })).body)
    expect(api.authorization).toBe('Bearer ghp_REAL_api')
    const git = JSON.parse((await viaProxy('github.com', token, routiniCa.certPem, { authorization: `Basic ${Buffer.from(`x:${PLACEHOLDER}`).toString('base64')}` })).body)
    expect(git.authorization).toBe(`Basic ${Buffer.from('x-access-token:ghp_REAL_git').toString('base64')}`)
    const anthropic = JSON.parse((await viaProxy('api.anthropic.com', token, routiniCa.certPem, { 'x-api-key': PLACEHOLDER })).body)
    expect(anthropic.xApiKey).toBe('sk-ant-REAL')
    // Bound hosts are served with Routini's CA, so a client trusting only the real CA fails.
    await expect(viaProxy('api.github.com', token, upstreamCa.certPem)).rejects.toThrow()
    const stats = (await control('GET', `/sessions/${token}/stats`)).body
    expect(stats.intercepted).toBeGreaterThanOrEqual(3)
  })

  it('forwards plain HTTP to allowed hosts but never adds credentials to it', async () => {
    const plainSession = 'd'.repeat(32)
    await control('PUT', `/sessions/${plainSession}`, session(plainSession, { bindings: [{ host: 'plain.example', header: 'authorization', format: 'bearer', secret: 'SHOULD_NOT_LEAK' }] }))
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: ports.proxyPort, method: 'GET', path: 'http://plain.example/x?y=1', headers: { 'proxy-authorization': `Basic ${Buffer.from(`routini:${plainSession}`).toString('base64')}` } },
        (resp) => {
          let b = ''
          resp.on('data', (c) => (b += c))
          resp.on('end', () => resolve({ status: resp.statusCode ?? 0, body: b }))
        },
      )
      r.on('error', reject)
      r.end()
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ authorization: null, path: '/x?y=1' })
  })

  it('expired sessions stop working', async () => {
    const expired = 'e'.repeat(32)
    await control('PUT', `/sessions/${expired}`, session(expired, { expiresAt: new Date(Date.now() - 1000).toISOString() }))
    expect((await viaProxy('api.github.com', expired, routiniCa.certPem)).connectStatus).toBe(407)
  })
})
