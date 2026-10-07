// ─────────────────────────────────────────────────────────────────────────────
// Egress proxy: the only way out of a sandboxed container.
//
// Proxy port (default 3128), used by containers via HTTPS_PROXY:
//   – Proxy-Authorization carries the session token (routini:<token>).
//   – CONNECT to a host not on the session's allow-list → 403, recorded.
//   – CONNECT to an allowed host *without* a credential binding → plain TCP
//     tunnel; the container talks TLS to the real server.
//   – CONNECT to a host *with* a binding → intercepted: TLS terminated with a
//     leaf certificate from Routini's CA (the container trusts it), each
//     request forwarded upstream over verified TLS with the real credential
//     set on the bound header. The container only ever holds a placeholder.
//   – Plain-HTTP requests to allowed hosts are forwarded; credentials are
//     never added to plain HTTP.
//
// Control port (default 3129), for the worker/API only (Bearer secret):
//   GET /health · GET /ca · PUT /sessions/:token · DELETE /sessions/:token
//   GET /sessions/:token/stats
// ─────────────────────────────────────────────────────────────────────────────

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { LeafIssuer, type CaMaterial } from './ca.js'
import type { CredentialBinding, EgressSession, SessionStats } from './types.js'
import { hostAllowed } from '../repos/policy.js'

export interface ProxyOptions {
  secret: string
  ca: CaMaterial
  /** Tests: trust these CAs for upstream TLS (in addition to the system store). */
  upstreamCa?: string[]
  /** Tests: map a hostname to a different address for the actual connection. */
  resolve?: (host: string, port: number) => { host: string; port: number }
  log?: (msg: string) => void
}

interface Live {
  session: EgressSession
  stats: SessionStats
}

const HOP_BY_HOP = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']
const MAX_BLOCKED = 50

/**
 * Answers a CONNECT with a complete (length-delimited) response and closes.
 * libcurl clients that probe before authenticating (git sets CURLAUTH_ANY)
 * only retry with credentials after a well-formed 407; a 407 ended by the
 * connection closing makes them fail with "Proxy CONNECT aborted".
 */
function refuseConnect(socket: Duplex, status: string, body = '', headers: string[] = []): void {
  const head = [`HTTP/1.1 ${status}`, ...headers, 'Content-Type: text/plain', `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', 'Proxy-Connection: close']
  socket.end(`${head.join('\r\n')}\r\n\r\n${body}`)
}

function credentialValue(b: CredentialBinding): string {
  switch (b.format) {
    case 'bearer':
      return `Bearer ${b.secret}`
    case 'basic-token':
      return `Basic ${Buffer.from(`x-access-token:${b.secret}`).toString('base64')}`
    case 'basic-pair':
      return `Basic ${Buffer.from(`${b.user ?? ''}:${b.secret}`).toString('base64')}`
    case 'token':
      return `Token token=${b.secret}`
    default:
      return b.secret
  }
}

function validSession(raw: unknown, token: string): EgressSession {
  const s = raw as Partial<EgressSession>
  const ok =
    s &&
    s.token === token &&
    typeof s.orgId === 'string' &&
    typeof s.label === 'string' &&
    Array.isArray(s.allowedHosts) &&
    s.allowedHosts.every((h) => typeof h === 'string') &&
    Array.isArray(s.bindings) &&
    s.bindings.every((b) => b && typeof b.host === 'string' && typeof b.header === 'string' && typeof b.secret === 'string') &&
    typeof s.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(s.expiresAt))
  if (!ok) throw new Error('invalid session')
  return s as EgressSession
}

export class EgressProxy {
  readonly sessions = new Map<string, Live>()
  private readonly issuer: LeafIssuer
  private readonly mitm: http.Server
  readonly proxy: http.Server
  readonly control: http.Server
  private readonly meta = new WeakMap<object, { live: Live; host: string; port: number }>()
  private readonly sweep: NodeJS.Timeout
  // Every client socket (including CONNECT tunnels, which the HTTP server stops tracking), for shutdown.
  private readonly sockets = new Set<net.Socket>()
  private readonly log: (m: string) => void

  constructor(private readonly opts: ProxyOptions) {
    this.issuer = new LeafIssuer(opts.ca)
    this.log = opts.log ?? ((m) => console.log(`[egress] ${m}`))
    this.mitm = http.createServer((req, res) => this.forwardIntercepted(req, res))
    this.proxy = http.createServer((req, res) => this.plainHttp(req, res))
    this.proxy.on('connect', (req, socket, head) => this.connect(req, socket, head))
    this.control = http.createServer((req, res) => void this.controlApi(req, res))
    for (const server of [this.proxy, this.control]) {
      server.on('connection', (s: net.Socket) => {
        this.sockets.add(s)
        s.on('close', () => this.sockets.delete(s))
      })
    }
    this.sweep = setInterval(() => {
      const now = Date.now()
      for (const [t, l] of this.sessions) if (Date.parse(l.session.expiresAt) < now) this.sessions.delete(t)
    }, 60_000)
    this.sweep.unref()
  }

  async listen(proxyPort: number, controlPort: number, host = '0.0.0.0'): Promise<{ proxyPort: number; controlPort: number }> {
    await new Promise<void>((r) => this.proxy.listen(proxyPort, host, r))
    await new Promise<void>((r) => this.control.listen(controlPort, host, r))
    return { proxyPort: (this.proxy.address() as net.AddressInfo).port, controlPort: (this.control.address() as net.AddressInfo).port }
  }

  async close(): Promise<void> {
    clearInterval(this.sweep)
    for (const s of this.sockets) s.destroy()
    await Promise.all([new Promise((r) => this.proxy.close(r)), new Promise((r) => this.control.close(r))])
  }

  // ── Session lookup ─────────────────────────────────────────────────────────

  private sessionFor(req: IncomingMessage): Live | null {
    const h = req.headers['proxy-authorization']
    if (!h?.startsWith('Basic ')) return null
    const decoded = Buffer.from(h.slice(6), 'base64').toString()
    const token = decoded.slice(decoded.indexOf(':') + 1)
    const live = this.sessions.get(token)
    if (!live || Date.parse(live.session.expiresAt) < Date.now()) return null
    return live
  }

  private block(live: Live, host: string): void {
    if (!live.stats.blocked.includes(host) && live.stats.blocked.length < MAX_BLOCKED) live.stats.blocked.push(host)
    this.log(`blocked ${host} for ${live.session.label}`)
  }

  private target(host: string, port: number) {
    return this.opts.resolve ? this.opts.resolve(host, port) : { host, port }
  }

  // ── CONNECT (HTTPS) ────────────────────────────────────────────────────────

  private connect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {})
    const live = this.sessionFor(req)
    if (!live) {
      refuseConnect(socket, '407 Proxy Authentication Required', '', ['Proxy-Authenticate: Basic realm="routini"'])
      return
    }
    const [rawHost, rawPort] = (req.url ?? '').split(':')
    const host = (rawHost ?? '').toLowerCase()
    const port = Number(rawPort) || 443
    if (!host || !hostAllowed(live.session.allowedHosts, host)) {
      this.block(live, host)
      refuseConnect(socket, '403 Forbidden', `${host || 'this host'} is blocked by Routini egress policy (add it to the org's allowed hosts)\n`)
      return
    }
    live.stats.requests++
    const bound = live.session.bindings.some((b) => b.host === host)
    if (!bound) {
      const t = this.target(host, port)
      let established = false
      const upstream = net.connect(t.port, t.host, () => {
        established = true
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', (err) => {
        this.log(`tunnel to ${host}:${port} failed: ${err.message}`)
        // Before the tunnel is up, refuse properly; after, just end the stream.
        if (established) socket.destroy()
        else refuseConnect(socket, '502 Bad Gateway', `could not reach ${host}:${port}\n`)
      })
      socket.on('close', () => upstream.destroy())
      return
    }
    // Intercept: terminate TLS as `host` and serve requests through the MITM server.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const tlsSocket = new tls.TLSSocket(socket as net.Socket, {
      isServer: true,
      secureContext: this.issuer.contextFor(host),
      ALPNProtocols: ['http/1.1'],
    })
    tlsSocket.on('error', () => socket.destroy())
    this.meta.set(tlsSocket, { live, host, port })
    if (head.length) tlsSocket.unshift(head)
    this.mitm.emit('connection', tlsSocket)
  }

  private forwardIntercepted(req: IncomingMessage, res: ServerResponse): void {
    const m = this.meta.get(req.socket)
    if (!m) {
      res.writeHead(500).end()
      return
    }
    m.live.stats.intercepted++
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.includes(k)) headers[k] = v
    for (const b of m.live.session.bindings.filter((x) => x.host === m.host)) headers[b.header.toLowerCase()] = credentialValue(b)
    headers['host'] = m.port === 443 ? m.host : `${m.host}:${m.port}`
    const t = this.target(m.host, m.port)
    const upstream = https.request(
      {
        host: t.host,
        port: t.port,
        servername: m.host,
        method: req.method,
        path: req.url,
        headers,
        ca: this.opts.upstreamCa ? [...tls.rootCertificates, ...this.opts.upstreamCa] : undefined,
      },
      (up) => {
        const out: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.includes(k)) out[k] = v
        res.writeHead(up.statusCode ?? 502, out)
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      this.log(`upstream ${m.host} failed: ${err.message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('upstream error\n')
    })
    req.pipe(upstream)
  }

  // ── Plain HTTP ─────────────────────────────────────────────────────────────

  private plainHttp(req: IncomingMessage, res: ServerResponse): void {
    const live = this.sessionFor(req)
    if (!live) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="routini"' }).end()
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    const host = url.hostname.toLowerCase()
    if (!hostAllowed(live.session.allowedHosts, host)) {
      this.block(live, host)
      res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked by Routini egress policy\n')
      return
    }
    live.stats.requests++
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.includes(k)) headers[k] = v
    const t = this.target(host, Number(url.port) || 80)
    const upstream = http.request({ host: t.host, port: t.port, method: req.method, path: url.pathname + url.search, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }

  // ── Control API ────────────────────────────────────────────────────────────

  private async controlApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    const url = new URL(req.url ?? '/', 'http://control')
    if (url.pathname === '/health') return json(200, { ok: true, sessions: this.sessions.size })
    const auth = req.headers.authorization ?? ''
    const expected = `Bearer ${this.opts.secret}`
    if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return json(401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/ca') return json(200, { pem: this.opts.ca.certPem })
    const m = /^\/sessions\/([a-f0-9]{16,128})(\/stats)?$/.exec(url.pathname)
    if (!m) return json(404, { error: 'not found' })
    const token = m[1]!
    if (req.method === 'PUT' && !m[2]) {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1_000_000) return json(413, { error: 'too large' })
      }
      try {
        const session = validSession(JSON.parse(body), token)
        const prev = this.sessions.get(token)
        this.sessions.set(token, { session, stats: prev?.stats ?? { requests: 0, intercepted: 0, blocked: [] } })
        return json(200, { ok: true })
      } catch {
        return json(400, { error: 'invalid session' })
      }
    }
    const live = this.sessions.get(token)
    if (!live) return json(404, { error: 'unknown session' })
    if (req.method === 'GET' && m[2]) return json(200, live.stats)
    if (req.method === 'DELETE' && !m[2]) {
      this.sessions.delete(token)
      return json(200, live.stats)
    }
    return json(405, { error: 'method not allowed' })
  }
}
