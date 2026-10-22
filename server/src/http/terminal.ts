// ─────────────────────────────────────────────────────────────────────────────
// Interactive terminal into an environment over WebSocket.
//
//   GET (Upgrade) /api/orgs/:org/environments/:id/terminal?cols=120&rows=32
//
// Auth: the session cookie or a Bearer token. Cookie sessions must come from
// the console's own origin (blocks cross-site WebSocket hijacking). Member role
// or higher. Starts the environment if it is stopped.
//
// Protocol: client → server JSON text frames {type:'input', data} and
// {type:'resize', cols, rows}; server → client raw terminal output (binary).
// Opening and closing a session is recorded in environment_events.
//
// An environment on Routini's own Docker host gets its shell with a plain
// `docker exec` (services/envRuntime.ts execTty); one on a fleet host gets it
// from that host's own routini-runner (RunnerGateway.openEnvTty), the same way
// http/hostTerminal.ts opens a shell on a fleet host itself.
// ─────────────────────────────────────────────────────────────────────────────

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AppContext } from './common.js'
import type { Auth } from './auth.js'
import { getMembershipRole, getOrgBySlug, roleAtLeast } from '../repos/identity.js'
import { addEnvironmentEvent } from '../repos/environments.js'
import { EnvError } from '../engine/environments.js'
import { getHost } from '../repos/hosts.js'
import { GatewayError } from '../runner/gateway.js'
import type { TtySession } from '../services/envRuntime.js'

const PATH_RE = /^\/api\/orgs\/([a-z0-9-]{1,40})\/environments\/([0-9a-f-]{36})\/terminal$/i
const TOUCH_EVERY_MS = 60_000

function reject(socket: Duplex, status: number, message: string): void {
  // The message can come from a runner (env.tty.error): keep it to one
  // printable line so it cannot add headers to this raw HTTP response.
  const text = message.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300) || 'Error'
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${text}`)
  socket.destroy()
}

/** A shell bridged to the WebSocket: a Docker exec's TtySession and a fleet host's PtySession, in one shape. */
interface Shell {
  onData(cb: (chunk: Buffer) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  /** Resolves with the shell's exit code once it exits. */
  done: Promise<number | null>
}

/** Adapts a Docker exec's Duplex stream to the same shape a fleet host's PtySession already has. */
function shellFromTty(tty: TtySession): Shell {
  return {
    onData: (cb) => tty.stream.on('data', cb),
    write: (data) => void tty.stream.write(data),
    resize: (cols, rows) => void tty.resize(cols, rows),
    close: () => void tty.stream.end(),
    done: tty.done,
  }
}

export function attachTerminal(server: Server, ctx: AppContext, auth: Auth): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  const allowedOrigin = new URL(ctx.config.clientUrl).origin

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const m = PATH_RE.exec(url.pathname)
    if (!m) return // not ours; other upgrade handlers (or none) deal with it
    void (async () => {
      const session = await auth.authenticate(req.headers)
      if (!session) return reject(socket, 401, 'Unauthorized')
      // Interactive shells are for people signed in to the console, not API tokens.
      if (session.apiToken) return reject(socket, 403, 'Terminals need a signed-in session')
      if (session.viaCookie && req.headers.origin !== allowedOrigin) return reject(socket, 403, 'Forbidden origin')
      const org = await getOrgBySlug(ctx.db, m[1]!)
      const role = org ? await getMembershipRole(ctx.db, org.id, session.user.id) : null
      if (!org || !role) return reject(socket, 404, 'Not Found')
      if (!roleAtLeast(role, 'member')) return reject(socket, 403, 'Forbidden')

      let env
      try {
        env = await ctx.envs.ensureRunning(org.id, m[2]!)
      } catch (err) {
        return reject(socket, err instanceof EnvError ? err.status : 500, err instanceof EnvError ? err.message : 'Environment unavailable')
      }
      const cols = Math.min(500, Math.max(10, Number(url.searchParams.get('cols')) || 120))
      const rows = Math.min(200, Math.max(5, Number(url.searchParams.get('rows')) || 32))

      // Open the shell before completing the upgrade, so listeners are attached
      // synchronously and input sent right after "open" is never dropped.
      let shell: Shell
      if (env.hostId) {
        const host = await ctx.db.org(org.id, (q) => getHost(q, org.id, env!.hostId!))
        if (!host?.runner || host.runner.revoked) {
          return reject(socket, 409, host ? `The environment's host "${host.name}" has no active runner` : "The environment's host has no active runner")
        }
        try {
          shell = await ctx.runners.openEnvTty(host.runner.id, env.containerId!, cols, rows)
        } catch (err) {
          if (err instanceof GatewayError) return reject(socket, err.status, err.message)
          console.error('[terminal] exec failed:', (err as Error).message)
          return reject(socket, 502, 'Could not open a shell')
        }
      } else {
        let tty: TtySession
        try {
          tty = await ctx.envs.runtime.execTty(env.containerId!, { cols, rows })
        } catch (err) {
          console.error('[terminal] exec failed:', (err as Error).message)
          return reject(socket, 502, 'Could not open a shell')
        }
        shell = shellFromTty(tty)
      }
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws, shell, ctx, org.id, env.id, session.user.id))
    })().catch((err) => {
      console.error('[terminal] upgrade failed:', (err as Error).message)
      reject(socket, 500, 'Internal Server Error')
    })
  })
  return wss
}

function serve(ws: WebSocket, shell: Shell, ctx: AppContext, orgId: string, envId: string, userId: string): void {
  const started = Date.now()
  void ctx.db.org(orgId, (q) => addEnvironmentEvent(q, orgId, envId, 'terminal.opened', userId)).catch(() => {})
  void ctx.envs.touch(orgId, envId).catch(() => {})
  const touch = setInterval(() => void ctx.envs.touch(orgId, envId).catch(() => {}), TOUCH_EVERY_MS)

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
    clearInterval(touch)
    shell.close()
    if (ws.readyState === ws.OPEN) ws.close(1000, reason)
    void ctx.db
      .org(orgId, (q) => addEnvironmentEvent(q, orgId, envId, 'terminal.closed', userId, { seconds: Math.round((Date.now() - started) / 1000) }))
      .catch(() => {})
  }
  ws.on('close', () => finish('client closed'))
  void shell.done.then(() => finish('shell exited'))
}
