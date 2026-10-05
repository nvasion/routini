// In-memory EnvRuntime for tests: tracks volumes and containers, scripts exec
// output, and gives the terminal an echoing TTY.

import { PassThrough, Duplex } from 'node:stream'
import type { EnvContainerSpec, EnvRuntime, ExecResult, TtySession } from '../../server/src/services/envRuntime'

export interface ExecCall {
  containerId: string
  cmd: string[]
  env: Record<string, string>
}

export type ExecScript = (call: ExecCall) => { lines?: string[]; exitCode?: number; hang?: boolean }

export class FakeEnvRuntime implements EnvRuntime {
  volumes = new Set<string>()
  containers = new Map<string, EnvContainerSpec & { running: boolean }>()
  execs: ExecCall[] = []
  resizes: Array<[number, number]> = []
  script: ExecScript = () => ({ exitCode: 0 })
  failStart = false
  private n = 0

  async ensureVolume(name: string) {
    this.volumes.add(name)
  }
  async removeVolume(name: string) {
    this.volumes.delete(name)
  }
  async startContainer(spec: EnvContainerSpec) {
    if (this.failStart) throw new Error('image not found')
    const id = `c${++this.n}`
    this.containers.set(id, { ...spec, running: true })
    return id
  }
  async removeContainer(id: string) {
    this.containers.delete(id)
  }
  async state(id: string) {
    const c = this.containers.get(id)
    return !c ? ('missing' as const) : c.running ? ('running' as const) : ('stopped' as const)
  }
  async exec(
    id: string,
    cmd: string[],
    opts: { env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal; onLine?: (l: string, s: 'stdout' | 'stderr') => void },
  ): Promise<ExecResult> {
    const call = { containerId: id, cmd, env: opts.env ?? {} }
    this.execs.push(call)
    const s = this.script(call)
    for (const l of s.lines ?? []) opts.onLine?.(l, 'stdout')
    if (s.hang) {
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return { exitCode: null, timedOut: false, aborted: true }
    }
    return { exitCode: s.exitCode ?? 0, timedOut: false, aborted: false }
  }
  async execTty(): Promise<TtySession> {
    // An "echo" shell: whatever is typed comes back prefixed, "exit" ends it.
    const out = new PassThrough()
    let finish!: (code: number | null) => void
    const done = new Promise<number | null>((r) => (finish = r))
    const stream = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        const text = chunk.toString()
        if (text.trim() === 'exit') {
          stream.push(null)
          finish(0)
        } else {
          stream.push(Buffer.from(`echo:${text}`))
        }
        cb()
      },
      final(cb) {
        stream.push(null)
        finish(0)
        cb()
      },
    })
    void out
    return {
      stream,
      resize: async (cols, rows) => {
        this.resizes.push([cols, rows])
      },
      done,
    }
  }
  async pull() {}
}
