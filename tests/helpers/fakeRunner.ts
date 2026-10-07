// A protocol-faithful fake routini-runner (PROTOCOL.md v1) for server tests.
// Connects to the gateway, says hello, and answers exec/pty frames through
// handlers the test supplies. Records every frame it receives.

import { WebSocket } from 'ws'

export interface ExecStart {
  id: string
  command: string
  env: Record<string, string>
  cwd: string | null
  timeoutSec: number
}

export interface AgentStart {
  id: string
  image: string
  pull: 'missing' | 'always'
  user: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  timeoutSec: number
  env: Record<string, string>
  labels: Record<string, string>
  egress: { image: string; network: string; session: Record<string, unknown> }
}

/** Counters an agent.exit may report about the host's egress proxy. */
export interface EgressStats {
  requests: number
  intercepted: number
  blocked: string[]
}

export interface ExitExtra {
  timedOut?: boolean
  canceled?: boolean
  error?: string | null
  egress?: EgressStats
}

/** An env.op frame (volume/network/container/exec/pull ops on a fleet host). */
export interface EnvOpStart {
  id: string
  op: string
  args: Record<string, unknown>
}

export interface EnvDoneExtra {
  ok?: boolean
  canceled?: boolean
  timedOut?: boolean
  error?: string | null
  exitCode?: number | null
  data?: Record<string, unknown> | null
}

export interface FakeRunnerOptions {
  baseUrl: string
  credential: string
  protocol?: string
  capabilities?: string[]
  facts?: Record<string, unknown>
  /** Default: print the command and exit 0. */
  onExec?: (start: ExecStart, r: FakeRunner) => void | Promise<void>
  /** Only called when the runner advertises the `agents` capability. */
  onAgent?: (start: AgentStart, r: FakeRunner) => void | Promise<void>
  /** Only called when the runner advertises the `environments` capability. */
  onEnvOp?: (start: EnvOpStart, r: FakeRunner) => void | Promise<void>
  /** Answers runner.update frames (PROTOCOL.md 2.7). */
  onUpdate?: (u: { id: string; version: string }, r: FakeRunner) => void | Promise<void>
  /** The version sent in hello (default 0.1.0-test). */
  version?: string
}

export class FakeRunner {
  readonly frames: Array<Record<string, unknown>> = []
  ws!: WebSocket
  closeCode: number | null = null
  welcomed!: Promise<Record<string, unknown>>
  closed!: Promise<number>
  private resolveWelcome!: (f: Record<string, unknown>) => void

  constructor(private readonly o: FakeRunnerOptions) {}

  /** Opens the connection. Resolves on `welcome`, or rejects with the HTTP status of a refused upgrade. */
  connect(): Promise<Record<string, unknown>> {
    const url = this.o.baseUrl.replace(/^http/, 'ws') + '/api/runner/connect'
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.o.credential}`, 'Routini-Runner-Protocol': this.o.protocol ?? '1' } })
    this.welcomed = new Promise((resolve) => (this.resolveWelcome = resolve))
    this.closed = new Promise((resolve) => this.ws.on('close', (code) => resolve((this.closeCode = code))))
    return new Promise((resolve, reject) => {
      this.ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })))
      this.ws.on('error', (err) => reject(err))
      this.ws.on('open', () => {
        this.send({
          type: 'hello',
          protocol: 1,
          version: this.o.version ?? '0.1.0-test',
          hostname: 'web-01.prod.example',
          os: 'linux',
          arch: 'amd64',
          capabilities: this.o.capabilities ?? ['exec', 'pty'],
          facts: this.o.facts ?? { kernel: 'Linux 6.8.0', uptimeSec: 90061, diskUsedPct: 63, memUsedPct: 41, addresses: ['10.0.0.11'] },
        })
      })
      this.ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as Record<string, unknown>
        this.frames.push(f)
        if (f['type'] === 'welcome') {
          this.resolveWelcome(f)
          resolve(f)
        }
        if (f['type'] === 'exec.start') void (this.o.onExec ?? defaultExec)(f as unknown as ExecStart, this)
        if (f['type'] === 'agent.start' && this.o.onAgent) void this.o.onAgent(f as unknown as AgentStart, this)
        if (f['type'] === 'env.op' && this.o.onEnvOp) void this.o.onEnvOp(f as unknown as EnvOpStart, this)
        if (f['type'] === 'runner.update' && this.o.onUpdate) void this.o.onUpdate(f as unknown as { id: string; version: string }, this)
      })
    })
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame))
  }

  output(id: string, data: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.send({ type: 'exec.output', id, stream, data })
  }

  exit(id: string, exitCode: number | null, extra: ExitExtra = {}): void {
    this.send({ type: 'exec.exit', id, ...exitFields(exitCode, extra) })
  }

  agentOutput(id: string, data: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.send({ type: 'agent.output', id, stream, data })
  }

  agentExit(id: string, exitCode: number | null, extra: ExitExtra = {}): void {
    this.send({ type: 'agent.exit', id, ...exitFields(exitCode, extra), egress: extra.egress ?? null })
  }

  envOutput(id: string, data: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.send({ type: 'env.output', id, stream, data })
  }

  envDone(id: string, extra: EnvDoneExtra = {}): void {
    this.send({
      type: 'env.done',
      id,
      ok: extra.ok ?? true,
      canceled: extra.canceled ?? false,
      timedOut: extra.timedOut ?? false,
      error: extra.error ?? null,
      exitCode: extra.exitCode ?? null,
      data: extra.data ?? null,
    })
  }

  /** Answers an `env.tty.open` with an opened terminal; data/error/exit push further frames. */
  envTtyOpened(id: string): void {
    this.send({ type: 'env.tty.opened', id })
  }

  envTtyError(id: string, message: string): void {
    this.send({ type: 'env.tty.error', id, message })
  }

  envTtyData(id: string, data: string): void {
    this.send({ type: 'env.tty.data', id, b64: Buffer.from(data, 'utf8').toString('base64') })
  }

  envTtyExit(id: string, exitCode: number | null): void {
    this.send({ type: 'env.tty.exit', id, exitCode })
  }

  updateResult(id: string, version: string, ok: boolean, extra: { error?: string; output?: string } = {}): void {
    this.send({ type: 'runner.update.result', id, version, ok, error: ok ? null : (extra.error ?? 'update failed'), output: extra.output ?? '' })
  }

  /** Waits for a frame of `type` (optionally matching `pred`). */
  async next(type: string, pred: (f: Record<string, unknown>) => boolean = () => true, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const start = Date.now()
    for (;;) {
      const f = this.frames.find((x) => x['type'] === type && pred(x))
      if (f) return f
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${type}; got ${this.frames.map((x) => x['type']).join(', ')}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  close(code = 1000): void {
    this.ws.close(code)
  }
}

const exitFields = (exitCode: number | null, extra: ExitExtra) => ({
  exitCode,
  timedOut: extra.timedOut ?? false,
  canceled: extra.canceled ?? false,
  error: extra.error ?? null,
})

const defaultExec = (s: ExecStart, r: FakeRunner) => {
  r.output(s.id, `ran: ${s.command}`)
  r.exit(s.id, 0)
}
