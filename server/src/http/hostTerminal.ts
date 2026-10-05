// ─────────────────────────────────────────────────────────────────────────────
// Interactive terminal on a fleet host over WebSocket.
//
//   GET (Upgrade) /api/orgs/:org/hosts/:id/terminal?cols=120&rows=32
//
// Runner hosts get a PTY from routini-runner (through the gateway instance that
// holds the runner); SSH hosts get an SSH login shell. Admins only: this is a
// shell on a real server. Every session is recorded in host_events.
// Same wire protocol as environment terminals: client → server JSON
// {type:'input', data} / {type:'resize', cols, rows}; server → client binary.
// ─────────────────────────────────────────────────────────────────────────────

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AppContext } from './common.js'
import type { Auth } from './auth.js'
import { getMembershipRole, getOrgBySlug, roleAtLeast } from '../repos/identity.js'
import { addHostEvent, getHost, type Host } from '../repos/hosts.js'
import { getSecret } from '../repos/credentials.js'
import { GatewayError } from '../runner/gateway.js'
import { openSsh2Shell, sshTargetAllowed, type SshShell } from '../services/ssh.js'

const PATH_RE = /^\/api\/orgs\/([a-z0-9-]{1,40})\/hosts\/([0-9a-f-]{36})\/terminal$/i

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`)
  socket.destroy()
}

class TerminalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function openShell(ctx: AppContext, orgId: string, host: Host, cols: number, rows: number): Promise<SshShell> {
  if (host.transport === 'runner') {
    if (!host.runner || host.runner.revoked) throw new TerminalError(409, 'This server has no active runner')
    try {
      return await ctx.runners.openPty(host.runner.id, cols, rows)
    } catch (err) {
      if (err instanceof GatewayError) throw new TerminalError(err.status, err.message)
      throw err
    }
  }
  if (!host.credentialKey || !host.username) throw new TerminalError(409, 'This host has no SSH credential configured')
  if (!(await sshTargetAllowed(host.address, ctx.config.mode === 'selfhost'))) throw new TerminalError(403, 'This host address is not allowed on this server')
  const { secret, passphrase } = await ctx.db.org(orgId, async (q) => ({
    secret: await getSecret(q, ctx.box, orgId, host.credentialKey!),
    passphrase: host.auth === 'key' ? await getSecret(q, ctx.box, orgId, `${host.credentialKey}.passphrase`) : null,
  }))
  if (!secret) throw new TerminalError(409, `Credential "${host.credentialKey}" is missing`)
  const open = ctx.actions?.sshShell ?? openSsh2Shell
  try {
    return await open(
      {
        host: host.address,
        port: host.port,
        username: host.username,
        readyTimeout: 15_000,
        ...(host.auth === 'key' ? { privateKey: secret, ...(passphrase ? { passphrase } : {}) } : { password: secret }),
      },
      { cols, rows },
    )
  } catch (err) {
    throw new TerminalError(502, (err as Error).message || 'SSH connection failed')
  }
}

export function attachHostTerminal(server: Server, ctx: AppContext, auth: Auth): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  const allowedOrigin = new URL(ctx.config.clientUrl).origin

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const m = PATH_RE.exec(url.pathname)
    if (!m) return
    void (async () => {
      const session = await auth.authenticate(req.headers)
      if (!session) return reject(socket, 401, 'Unauthorized')
      // Interactive shells are for people signed in to the console, not API tokens.
      if (session.apiToken) return reject(socket, 403, 'Terminals need a signed-in session')
      if (session.viaCookie && req.headers.origin !== allowedOrigin) return reject(socket, 403, 'Forbidden origin')
      const org = await getOrgBySlug(ctx.db, m[1]!)
      const role = org ? await getMembershipRole(ctx.db, org.id, session.user.id) : null
      if (!org || !role) return reject(socket, 404, 'Not Found')
      if (!roleAtLeast(role, 'admin')) return reject(socket, 403, 'Forbidden')
      const host = await ctx.db.org(org.id, (q) => getHost(q, org.id, m[2]!))
      if (!host) return reject(socket, 404, 'Not Found')

      const cols = Math.min(500, Math.max(10, Number(url.searchParams.get('cols')) || 120))
      const rows = Math.min(200, Math.max(5, Number(url.searchParams.get('rows')) || 32))
      let shell: SshShell
      try {
        shell = await openShell(ctx, org.id, host, cols, rows)
      } catch (err) {
        if (err instanceof TerminalError) return reject(socket, err.status, err.message)
        console.error('[host-terminal] open failed:', (err as Error).message)
        return reject(socket, 502, 'Could not open a shell')
      }
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws, shell, ctx, org.id, host, session.user.id))
    })().catch((err) => {
      console.error('[host-terminal] upgrade failed:', (err as Error).message)
      reject(socket, 500, 'Internal Server Error')
    })
  })
  return wss
}

function serve(ws: WebSocket, shell: SshShell, ctx: AppContext, orgId: string, host: Host, userId: string): void {
  const started = Date.now()
  const via = host.transport
  void ctx.db.org(orgId, (q) => addHostEvent(q, orgId, host.id, 'terminal.opened', userId, { via })).catch(() => {})

  shell.onData((chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true })
  })
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown }
    try {
      msg = JSON.parse(raw.toString()) as typeof msg
    } catch {
      return
    }
    if (msg.type === 'input' && typeof msg.data === 'string') shell.write(msg.data)
    else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      shell.resize(Math.min(500, Math.max(10, msg.cols as number)), Math.min(200, Math.max(5, msg.rows as number)))
    }
  })

  let closed = false
  const finish = (reason: string) => {
    if (closed) return
    closed = true
    shell.close()
    if (ws.readyState === ws.OPEN) ws.close(1000, reason)
    void ctx.db
      .org(orgId, (q) => addHostEvent(q, orgId, host.id, 'terminal.closed', userId, { via, seconds: Math.round((Date.now() - started) / 1000) }))
      .catch(() => {})
  }
  ws.on('close', () => finish('client closed'))
  void shell.done.then(() => finish('shell exited'))
}
