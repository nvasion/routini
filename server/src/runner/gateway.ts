// ─────────────────────────────────────────────────────────────────────────────
// Runner gateway: where routini-runner control connections end (API process).
//
//   GET (Upgrade) /api/runner/connect
//   Authorization: Bearer rrc_…   Routini-Runner-Protocol: 1
//
// Protocol: routini-runner/PROTOCOL.md (v1). Workers never talk to runners
// directly: they insert runner_tasks and NOTIFY `routini_runner`; the instance
// holding that runner's connection claims the task and sends exec.start.
// Output comes back to the waiting worker on `routini_runner_out`, batched
// every 100 ms (each NOTIFY stays well under Postgres' 8 KB payload limit).
//
// Interactive terminals (pty.*) are served by the instance that holds the
// runner; see openPty().
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AppContext } from '../http/common.js'
import { addHostEvent, checkFromFacts, recordHostCheck } from '../repos/hosts.js'
import {
  claimRunnerTask,
  finishRunnerTask,
  getRunnerByCredential,
  getRunnerTask,
  markRunnerConnected,
  markRunnerDisconnected,
  queuedTasksFor,
  recordRunnerFacts,
  RUNNER_CHANNEL,
  RUNNER_OUT_CHANNEL,
  sealedAad,
  sentTasksFor,
  touchRunner,
  type AgentSecret,
  type ExecResultData,
  type Runner,
  type RunnerTask,
} from '../repos/runners.js'

/** A runner without the "agents" capability cannot be asked to run one. */
export const NO_AGENTS_ERROR = 'This host\'s runner does not run agents; enable "agents" in its config.json'

/** A runner without the "environments" capability cannot be asked to run environment ops. */
export const NO_ENVIRONMENTS_ERROR = 'This host\'s runner does not run environments; it needs routini-runner v0.4.0 or newer with agents enabled'

const CAPABILITIES = ['exec', 'pty', 'agents', 'update', 'environments'] as const

export const PROTOCOL_VERSION = 1
const CONNECT_PATH = '/api/runner/connect'
const MAX_NOTIFY_BYTES = 6000
const MAX_LINE = 4000
const MAX_BLOCKED = 100
const MAX_HOST = 253

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface GatewayOptions {
  pingMs?: number
  /** Close a runner that has not answered a ping for this long. */
  deadMs?: number
  helloTimeoutMs?: number
  flushMs?: number
}

/** An interactive shell on a runner host. */
export interface PtySession {
  readonly id: string
  onData(cb: (chunk: Buffer) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  /** Resolves with the shell's exit code when the session ends. */
  done: Promise<number | null>
}

interface Conn {
  /** This connection (instance + suffix); stored as runners.instance and runner_tasks.claimed_by. */
  key: string
  ws: WebSocket
  runner: Runner
  lastPong: number
  ping: NodeJS.Timeout
  /** Pending output per task, flushed on a timer. */
  out: Map<string, Array<{ s: 'stdout' | 'stderr'; d: string }>>
  flushTimer: NodeJS.Timeout | null
  flushing: Promise<void>
  ptys: Map<string, PtyImpl>
  /** runner.update requests sent on this connection, by request id. */
  updates: Map<string, { version: string; userId: string | null }>
  closed: boolean
}

/** Shown when a runner cannot update itself (no helper, or before v0.3.0). */
export const NO_UPDATE_ERROR = 'This runner cannot be updated from Routini. Re-run install.sh on the host once (v0.3.0 or newer); after that, updates work from here.'

const MAX_UPDATE_OUTPUT = 4000

/** Frame prefix for a PtyImpl: a host shell (pty.*) or a shell inside an environment container (env.tty.*). */
type PtyFramePrefix = 'pty' | 'env.tty'

class PtyImpl extends EventEmitter implements PtySession {
  done: Promise<number | null>
  private resolveDone!: (code: number | null) => void
  private ended = false
  constructor(
    readonly id: string,
    private readonly prefix: PtyFramePrefix,
    private readonly send: (frame: object) => void,
  ) {
    super()
    this.done = new Promise((r) => (this.resolveDone = r))
  }
  private early: Buffer[] = []
  /** Output before anyone listens (the first prompt) is kept and replayed. */
  push(chunk: Buffer) {
    if (this.listenerCount('data')) this.emit('data', chunk)
    else if (this.early.length < 256) this.early.push(chunk)
  }
  onData(cb: (chunk: Buffer) => void) {
    this.on('data', cb)
    for (const c of this.early.splice(0)) cb(c)
  }
  write(data: string) {
    if (!this.ended) this.send({ type: `${this.prefix}.input`, id: this.id, b64: Buffer.from(data, 'utf8').toString('base64') })
  }
  resize(cols: number, rows: number) {
    if (!this.ended) this.send({ type: `${this.prefix}.resize`, id: this.id, cols, rows })
  }
  close() {
    if (this.ended) return
    this.send({ type: `${this.prefix}.close`, id: this.id })
    this.end(null)
  }
  end(code: number | null) {
    if (this.ended) return
    this.ended = true
    this.resolveDone(code)
  }
}

export class RunnerGateway {
  readonly instance = randomUUID()
  private readonly conns = new Map<string, Conn>()
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  private unlisten: (() => Promise<void>) | null = null
  private readonly opts: Required<GatewayOptions>

  constructor(
    private readonly ctx: AppContext,
    opts: GatewayOptions = {},
  ) {
    this.opts = { pingMs: 20_000, deadMs: 60_000, helloTimeoutMs: 10_000, flushMs: 100, ...opts }
  }

  async start(): Promise<void> {
    this.unlisten = await this.ctx.db.listen(RUNNER_CHANNEL, (payload) => {
      let msg: { op?: string; taskId?: string; runnerId?: string; instance?: string; requestId?: string; version?: string; userId?: string | null }
      try {
        msg = JSON.parse(payload) as typeof msg
      } catch {
        return
      }
      const conn = msg.runnerId ? this.conns.get(msg.runnerId) : undefined
      if (!conn) return
      if (msg.op === 'start' && msg.taskId) void this.dispatch(conn, msg.taskId)
      else if (msg.op === 'cancel' && msg.taskId) void this.cancel(conn, msg.taskId)
      else if (msg.op === 'revoke') this.revokeLocal(conn)
      else if (msg.op === 'update' && msg.requestId && msg.version) void this.updateLocal(conn, msg.requestId, msg.version, msg.userId ?? null)
      else if (msg.op === 'replace' && msg.instance !== conn.key) this.drop(conn, 4000, 'replaced by a newer connection')
    })
  }

  async stop(): Promise<void> {
    await this.unlisten?.()
    for (const c of this.conns.values()) this.drop(c, 1001, 'server shutting down')
    this.wss.close()
  }

  /** Handles upgrades for /api/runner/connect; other paths are left alone. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== CONNECT_PATH) return
      void this.upgrade(req, socket, head).catch((err) => {
        console.error('[runner] upgrade failed:', (err as Error).message)
        reject(socket, 500, 'Internal Server Error')
      })
    })
  }

  isConnected(runnerId: string): boolean {
    return this.conns.has(runnerId)
  }

  /** Revokes a runner wherever it is connected (send `revoked`, close). */
  async revoke(runnerId: string): Promise<void> {
    const local = this.conns.get(runnerId)
    if (local) this.revokeLocal(local)
    else await this.ctx.db.query('SELECT pg_notify($1, $2)', [RUNNER_CHANNEL, JSON.stringify({ op: 'revoke', runnerId })])
  }

  /**
   * Asks a runner, wherever it is connected, to update itself to `version`
   * (PROTOCOL.md section 2.7). The outcome lands in the host's events:
   * runner.update.succeeded / runner.update.failed, then runner.connected
   * with the new version once the service has restarted.
   */
  async requestUpdate(runnerId: string, r: { requestId: string; version: string; userId: string | null }): Promise<void> {
    const local = this.conns.get(runnerId)
    if (local) await this.updateLocal(local, r.requestId, r.version, r.userId)
    else await this.ctx.db.query('SELECT pg_notify($1, $2)', [RUNNER_CHANNEL, JSON.stringify({ op: 'update', runnerId, ...r })])
  }

  private async updateLocal(conn: Conn, requestId: string, version: string, userId: string | null): Promise<void> {
    if (!conn.runner.capabilities.includes('update')) {
      await this.updateEvent(conn, 'runner.update.failed', userId, { version, error: NO_UPDATE_ERROR })
      return
    }
    conn.updates.set(requestId, { version, userId })
    this.send(conn, { type: 'runner.update', id: requestId, version })
  }

  private async onUpdateResult(conn: Conn, id: string, f: Record<string, unknown>): Promise<void> {
    const req = conn.updates.get(id)
    if (!req) return // not a request this connection sent
    conn.updates.delete(id)
    const ok = f['ok'] === true
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null)
    await this.updateEvent(conn, ok ? 'runner.update.succeeded' : 'runner.update.failed', req.userId, {
      version: req.version,
      ...(ok ? {} : { error: text(f['error'], 500) ?? 'The update failed' }),
      output: text(f['output'], MAX_UPDATE_OUTPUT) ?? '',
    })
  }

  private async updateEvent(conn: Conn, type: string, userId: string | null, data: Record<string, unknown>): Promise<void> {
    const { orgId, hostId } = conn.runner
    if (!hostId) return
    await this.ctx.db.org(orgId, (q) => addHostEvent(q, orgId, hostId, type, userId, data)).catch((err) => {
      console.error('[runner] could not record an update event:', (err as Error).message)
    })
  }

  /** Opens a terminal on a runner held by this instance. */
  async openPty(runnerId: string, cols: number, rows: number, timeoutMs = 10_000): Promise<PtySession> {
    const conn = this.conns.get(runnerId)
    if (!conn) throw new GatewayError(503, 'The runner is offline or connected to another Routini API instance')
    if (!conn.runner.capabilities.includes('pty')) throw new GatewayError(409, 'Terminals are disabled on this runner')
    return this.openPtySession(conn, 'pty', { cols, rows }, timeoutMs)
  }

  /** Opens a shell inside an environment's container on a runner held by this instance. */
  async openEnvTty(runnerId: string, containerId: string, cols: number, rows: number, timeoutMs = 10_000): Promise<PtySession> {
    const conn = this.conns.get(runnerId)
    if (!conn) throw new GatewayError(503, 'The runner is offline or connected to another Routini API instance')
    if (!conn.runner.capabilities.includes('environments')) throw new GatewayError(409, NO_ENVIRONMENTS_ERROR)
    return this.openPtySession(conn, 'env.tty', { cols, rows, containerId }, timeoutMs)
  }

  private async openPtySession(conn: Conn, prefix: PtyFramePrefix, open: Record<string, unknown>, timeoutMs: number): Promise<PtySession> {
    const id = randomUUID()
    const pty = new PtyImpl(id, prefix, (f) => this.send(conn, f))
    conn.ptys.set(id, pty)
    void pty.done.then(() => conn.ptys.delete(id))
    const opened = new Promise<void>((resolve, rejectP) => {
      const t = setTimeout(() => rejectP(new GatewayError(504, 'The runner did not open a terminal in time')), timeoutMs)
      pty.once('opened', () => {
        clearTimeout(t)
        resolve()
      })
      pty.once('error', (message: string) => {
        clearTimeout(t)
        rejectP(new GatewayError(409, message))
      })
    })
    this.send(conn, { type: `${prefix}.open`, id, ...open })
    try {
      await opened
    } catch (err) {
      pty.end(null)
      throw err
    }
    return pty
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (req.headers['routini-runner-protocol'] !== String(PROTOCOL_VERSION)) return reject(socket, 426, 'Unsupported runner protocol')
    const auth = req.headers.authorization ?? ''
    const credential = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const runner = credential ? await this.ctx.db.system((q) => getRunnerByCredential(q, credential)) : null
    if (!runner || runner.revokedAt) return reject(socket, 401, 'Unknown or revoked runner credential')
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, runner))
  }

  private accept(ws: WebSocket, runner: Runner): void {
    let helloDone = false
    const helloTimer = setTimeout(() => {
      if (!helloDone) ws.close(1002, 'expected hello')
    }, this.opts.helloTimeoutMs)
    // Frames that arrive while the hello is being recorded are replayed after it.
    const pending: string[] = []
    let conn: Conn | null = null
    let socketClosed = false

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      if (conn) return void this.onFrame(conn, raw.toString())
      if (helloDone) return void pending.push(raw.toString())
      let hello: Record<string, unknown>
      try {
        hello = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (hello['type'] !== 'hello') return
      helloDone = true
      clearTimeout(helloTimer)
      void this.onHello(ws, runner, hello)
        .then(async (c) => {
          conn = c
          for (const f of pending.splice(0)) this.onFrame(c, f)
          if (socketClosed) return this.onClose(c)
          // Catch up on commands queued while the runner was away.
          const queued = await this.ctx.db.org(c.runner.orgId, (q) => queuedTasksFor(q, c.runner.orgId, c.runner.id))
          for (const id of queued) await this.dispatch(c, id)
        })
        .catch((err) => {
          console.error('[runner] hello failed:', (err as Error).message)
          ws.close(1011, 'internal error')
        })
    })
    ws.on('close', () => {
      socketClosed = true
      clearTimeout(helloTimer)
      if (conn) void this.onClose(conn)
    })
    ws.on('error', () => {})
  }

  private async onHello(ws: WebSocket, runner: Runner, hello: Record<string, unknown>): Promise<Conn> {
    const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')
    const capabilities = Array.isArray(hello['capabilities'])
      ? (hello['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c))
      : []
    const facts = isObj(hello['facts']) ? (hello['facts'] as Record<string, unknown>) : null
    const info = { version: str(hello['version'], 40), hostname: str(hello['hostname'], 253), os: str(hello['os'], 40), arch: str(hello['arch'], 40), capabilities, facts }

    const key = `${this.instance}/${randomUUID().slice(0, 8)}`
    // One connection per runner: replace any older one, here or on another instance.
    const old = this.conns.get(runner.id)
    if (old) this.drop(old, 4000, 'replaced by a newer connection')

    await this.ctx.db.org(runner.orgId, async (q) => {
      await markRunnerConnected(q, runner.orgId, runner.id, info, key)
      if (runner.hostId) {
        const address = Array.isArray(facts?.['addresses']) && typeof (facts!['addresses'] as unknown[])[0] === 'string' ? ((facts!['addresses'] as string[])[0] as string) : info.hostname
        if (address) await q.query(`UPDATE hosts SET address = $3 WHERE org_id = $1 AND id = $2`, [runner.orgId, runner.hostId, address.slice(0, 253)])
        if (facts) await recordHostCheck(q, runner.orgId, runner.hostId, checkFromFacts(facts))
        await addHostEvent(q, runner.orgId, runner.hostId, 'runner.connected', null, { version: info.version, hostname: info.hostname })
      }
      await q.query('SELECT pg_notify($1, $2)', [RUNNER_CHANNEL, JSON.stringify({ op: 'replace', runnerId: runner.id, instance: key })])
    })

    const conn: Conn = {
      key,
      ws,
      runner: { ...runner, ...info, capabilities },
      lastPong: Date.now(),
      ping: setInterval(() => this.heartbeat(conn), this.opts.pingMs),
      out: new Map(),
      flushTimer: null,
      flushing: Promise.resolve(),
      ptys: new Map(),
      updates: new Map(),
      closed: false,
    }
    ws.on('pong', () => {
      conn.lastPong = Date.now()
    })
    this.conns.set(runner.id, conn)
    this.send(conn, { type: 'welcome', runnerId: runner.id, name: runner.name })
    return conn
  }

  private heartbeat(conn: Conn): void {
    if (Date.now() - conn.lastPong > this.opts.deadMs) {
      conn.ws.terminate()
      return
    }
    try {
      conn.ws.ping()
    } catch {
      // closed underneath us; the close handler cleans up
    }
    void this.ctx.db.org(conn.runner.orgId, (q) => touchRunner(q, conn.runner.orgId, conn.runner.id)).catch(() => {})
  }

  private async onClose(conn: Conn): Promise<void> {
    if (conn.closed) return
    conn.closed = true
    clearInterval(conn.ping)
    if (this.conns.get(conn.runner.id) === conn) this.conns.delete(conn.runner.id)
    for (const p of conn.ptys.values()) p.end(null)
    await this.flush(conn)
    const { orgId, id, hostId } = conn.runner
    await this.ctx.db
      .org(orgId, async (q) => {
        // Commands this instance had sent can no longer report back.
        for (const taskId of await sentTasksFor(q, orgId, id, conn.key)) {
          await finishRunnerTask(q, orgId, taskId, 'failed', { exitCode: null, timedOut: false, canceled: false, error: 'Runner disconnected' })
        }
        const mine = await markRunnerDisconnected(q, orgId, id, conn.key)
        if (mine && hostId) await addHostEvent(q, orgId, hostId, 'runner.disconnected', null)
      })
      .catch((err) => console.error('[runner] disconnect bookkeeping failed:', (err as Error).message))
  }

  private drop(conn: Conn, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason)
    } catch {
      conn.ws.terminate()
    }
  }

  private revokeLocal(conn: Conn): void {
    this.send(conn, { type: 'revoked' })
    this.drop(conn, 1000, 'runner removed')
  }

  private send(conn: Conn, frame: object): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(frame))
  }

  // ── Frames from the runner ──────────────────────────────────────────────────

  private onFrame(conn: Conn, raw: string): void {
    let f: Record<string, unknown>
    try {
      f = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const id = typeof f['id'] === 'string' ? f['id'] : ''
    switch (f['type']) {
      case 'facts':
        if (isObj(f['facts'])) void this.onFacts(conn, f['facts'] as Record<string, unknown>)
        return
      case 'exec.output':
      case 'agent.output':
      case 'env.output': {
        if (!id || typeof f['data'] !== 'string') return
        const s = f['stream'] === 'stderr' ? 'stderr' : 'stdout'
        const d = (f['data'] as string).length > MAX_LINE ? `${(f['data'] as string).slice(0, MAX_LINE)}…` : (f['data'] as string)
        const list = conn.out.get(id) ?? []
        list.push({ s, d })
        conn.out.set(id, list)
        if (!conn.flushTimer) conn.flushTimer = setTimeout(() => void this.flush(conn), this.opts.flushMs)
        return
      }
      case 'exec.exit':
      case 'agent.exit':
        if (id) void this.onExit(conn, id, f)
        return
      case 'env.done':
        if (id) void this.onEnvDone(conn, id, f)
        return
      case 'runner.update.result':
        if (id) void this.onUpdateResult(conn, id, f)
        return
      case 'pty.opened':
      case 'env.tty.opened':
        conn.ptys.get(id)?.emit('opened')
        return
      case 'pty.error':
      case 'env.tty.error':
        conn.ptys.get(id)?.emit('error', typeof f['message'] === 'string' ? f['message'] : 'The runner could not open a terminal')
        return
      case 'pty.data':
      case 'env.tty.data': {
        const p = conn.ptys.get(id)
        if (p && typeof f['b64'] === 'string') p.push(Buffer.from(f['b64'] as string, 'base64'))
        return
      }
      case 'pty.exit':
      case 'env.tty.exit':
        conn.ptys.get(id)?.end(typeof f['exitCode'] === 'number' ? (f['exitCode'] as number) : null)
        return
      default:
        return // unknown types are ignored (forward compatible)
    }
  }

  private async onFacts(conn: Conn, facts: Record<string, unknown>): Promise<void> {
    const { orgId, id, hostId } = conn.runner
    await this.ctx.db
      .org(orgId, async (q) => {
        await recordRunnerFacts(q, orgId, id, facts)
        if (hostId) await recordHostCheck(q, orgId, hostId, checkFromFacts(facts))
      })
      .catch(() => {})
  }

  private async onExit(conn: Conn, taskId: string, f: Record<string, unknown>): Promise<void> {
    await this.flush(conn)
    const result: ExecResultData = {
      exitCode: typeof f['exitCode'] === 'number' ? (f['exitCode'] as number) : null,
      timedOut: f['timedOut'] === true,
      canceled: f['canceled'] === true,
      error: typeof f['error'] === 'string' && f['error'] ? (f['error'] as string).slice(0, 500) : null,
      egress: egressStats(f['egress']),
    }
    const status = result.canceled ? 'canceled' : result.error ? 'failed' : 'done'
    await this.finish(conn.runner.orgId, taskId, status, result)
  }

  private async onEnvDone(conn: Conn, taskId: string, f: Record<string, unknown>): Promise<void> {
    await this.flush(conn)
    const canceled = f['canceled'] === true
    const ok = f['ok'] === true
    const result: ExecResultData = {
      exitCode: typeof f['exitCode'] === 'number' ? (f['exitCode'] as number) : null,
      timedOut: f['timedOut'] === true,
      canceled,
      error: typeof f['error'] === 'string' && f['error'] ? (f['error'] as string).slice(0, 500) : null,
      data: isObj(f['data']) ? (f['data'] as Record<string, unknown>) : null,
    }
    const status = canceled ? 'canceled' : ok ? 'done' : 'failed'
    await this.finish(conn.runner.orgId, taskId, status, result)
  }

  /** Sends buffered output to waiting workers, in order, in NOTIFY-sized batches. */
  private flush(conn: Conn): Promise<void> {
    if (conn.flushTimer) clearTimeout(conn.flushTimer)
    conn.flushTimer = null
    const batches: Array<{ taskId: string; lines: Array<{ s: string; d: string }> }> = []
    for (const [taskId, lines] of conn.out) {
      let cur: Array<{ s: string; d: string }> = []
      let size = 0
      for (const l of lines) {
        const n = Buffer.byteLength(l.d) + 16
        if (cur.length && size + n > MAX_NOTIFY_BYTES) {
          batches.push({ taskId, lines: cur })
          cur = []
          size = 0
        }
        cur.push(l)
        size += n
      }
      if (cur.length) batches.push({ taskId, lines: cur })
    }
    conn.out.clear()
    conn.flushing = conn.flushing.then(async () => {
      for (const b of batches) {
        await this.ctx.db.query('SELECT pg_notify($1, $2)', [RUNNER_OUT_CHANNEL, JSON.stringify(b)]).catch(() => {})
      }
    })
    return conn.flushing
  }

  // ── Tasks from workers ──────────────────────────────────────────────────────

  private async dispatch(conn: Conn, taskId: string): Promise<void> {
    const { orgId } = conn.runner
    const task = await this.ctx.db.org(orgId, (q) => claimRunnerTask(q, orgId, taskId, conn.key)).catch(() => null)
    if (!task) return // someone else claimed it, or it is not queued any more
    if (task.cancelRequested) return void (await this.finish(orgId, task.id, 'canceled', { exitCode: null, timedOut: false, canceled: true, error: null }))

    let frame: object
    try {
      frame = this.startFrame(conn, task)
    } catch (err) {
      await this.finish(orgId, task.id, 'failed', { exitCode: null, timedOut: false, canceled: false, error: (err as Error).message })
      return
    }
    this.send(conn, frame)
    // A cancel may have landed between the claim and the send.
    const fresh = await this.ctx.db.org(orgId, (q) => getRunnerTask(q, orgId, task.id)).catch(() => null)
    if (fresh?.cancelRequested) this.send(conn, { type: cancelType(task), id: task.id })
  }

  /** Builds the start frame for a task; throws a runner-visible message it cannot run. */
  private startFrame(conn: Conn, task: RunnerTask): object {
    const p = task.payload
    if (p.type === 'exec') {
      return { type: 'exec.start', id: task.id, command: p.command, env: p.env ?? {}, cwd: p.cwd ?? null, timeoutSec: p.timeoutSec }
    }
    if (p.type === 'env') {
      if (!conn.runner.capabilities.includes('environments')) throw new Error(NO_ENVIRONMENTS_ERROR)
      let openedSecretArgs: Record<string, unknown> = {}
      if (p.sealed) {
        try {
          openedSecretArgs = JSON.parse(this.ctx.box.open(p.sealed, sealedAad(task.id))) as Record<string, unknown>
        } catch (err) {
          throw new Error(`Could not open the environment task's secrets: ${(err as Error).message}`)
        }
      }
      return { type: 'env.op', id: task.id, op: p.op, args: { ...p.args, ...openedSecretArgs } }
    }
    if (!conn.runner.capabilities.includes('agents')) throw new Error(NO_AGENTS_ERROR)
    let secret: AgentSecret
    try {
      secret = JSON.parse(this.ctx.box.open(p.sealed, sealedAad(task.id))) as AgentSecret
    } catch (err) {
      throw new Error(`Could not open the agent task's secrets: ${(err as Error).message}`)
    }
    return {
      type: 'agent.start',
      id: task.id,
      image: p.image,
      pull: p.pull,
      user: p.user,
      cpus: p.cpus,
      memoryMb: p.memoryMb,
      pidsLimit: p.pidsLimit,
      timeoutSec: p.timeoutSec,
      env: secret.env,
      labels: p.labels,
      egress: { image: p.egressImage, network: p.network, session: secret.session },
    }
  }

  /** Cancels a task on the runner, with the frame its kind understands. */
  private async cancel(conn: Conn, taskId: string): Promise<void> {
    const { orgId } = conn.runner
    const task = await this.ctx.db.org(orgId, (q) => getRunnerTask(q, orgId, taskId)).catch(() => null)
    this.send(conn, { type: task ? cancelType(task) : 'exec.cancel', id: taskId })
  }

  private async finish(orgId: string, taskId: string, status: 'done' | 'failed' | 'canceled', result: ExecResultData): Promise<void> {
    await this.ctx.db.org(orgId, (q) => finishRunnerTask(q, orgId, taskId, status, result)).catch((err) => {
      console.error('[runner] could not record a task result:', (err as Error).message)
    })
  }
}

const cancelType = (task: RunnerTask) => (task.payload.type === 'agent' ? 'agent.cancel' : task.payload.type === 'env' ? 'env.cancel' : 'exec.cancel')

/**
 * Validates the egress counters an agent.exit reports; null when absent or
 * malformed. Bounded, because the result is stored and shown in the timeline.
 */
function egressStats(v: unknown): ExecResultData['egress'] {
  if (!isObj(v)) return null
  const e = v as Record<string, unknown>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0)
  const blocked = Array.isArray(e['blocked'])
    ? (e['blocked'] as unknown[]).filter((h): h is string => typeof h === 'string').map((h) => h.slice(0, MAX_HOST)).slice(0, MAX_BLOCKED)
    : []
  return { requests: num(e['requests']), intercepted: num(e['intercepted']), blocked }
}

function isObj(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function reject(socket: Duplex, status: number, message: string): void {
  const text = { 401: 'Unauthorized', 426: 'Upgrade Required', 500: 'Internal Server Error' }[status] ?? 'Error'
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`)
  socket.destroy()
}
