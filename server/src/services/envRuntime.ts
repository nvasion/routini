// ─────────────────────────────────────────────────────────────────────────────
// Environment runtime: long-lived workspace containers on the Docker host.
//
// An environment is a container (idle process) plus a named volume mounted at
// /workspace. Stopping removes the container and keeps the volume; starting
// creates a fresh container on the same volume. Commands run with `exec`:
// streamed (agent steps, setup) or as an interactive TTY (the terminal).
// Same sandbox settings as agent containers: uid 1000, CapDrop ALL,
// no-new-privileges, CPU and memory limits.
// ─────────────────────────────────────────────────────────────────────────────

import Dockerode from 'dockerode'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { createDemuxer, lineSplitter } from './docker.js'

export const ENV_USER = '1000:1000'
export const WORKSPACE = '/workspace'

export interface EnvContainerSpec {
  name: string
  image: string
  volume: string
  labels: Record<string, string>
  cpus: number
  memoryMb: number
}

export interface ExecResult {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}

export interface TtySession {
  stream: Duplex
  resize(cols: number, rows: number): Promise<void>
  /** Resolves with the shell's exit code once it exits. */
  done: Promise<number | null>
}

export interface EnvRuntime {
  ensureVolume(name: string, labels: Record<string, string>): Promise<void>
  removeVolume(name: string): Promise<void>
  /** Creates and starts a container; returns its id. */
  startContainer(spec: EnvContainerSpec): Promise<string>
  /** Stops and removes the container (volume untouched). Missing containers are fine. */
  removeContainer(id: string): Promise<void>
  state(id: string): Promise<'running' | 'stopped' | 'missing'>
  exec(
    id: string,
    cmd: string[],
    opts: { env?: Record<string, string>; workdir?: string; timeoutMs: number; signal?: AbortSignal; onLine?: (line: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<ExecResult>
  execTty(id: string, opts: { cols: number; rows: number; cmd?: string[] }): Promise<TtySession>
  pull(image: string): Promise<void>
}

/** Kills the process tree rooted at the pid in "$0": children first, TERM then KILL. */
const KILL_TREE = [
  'tree() { for c in $(cat /proc/$1/task/*/children 2>/dev/null); do tree $c; done; echo $1; }',
  'root=$(cat "$0" 2>/dev/null) || exit 0',
  'pids=$(tree $root)',
  'kill -TERM $pids 2>/dev/null; sleep 2; kill -KILL $pids 2>/dev/null; true',
].join('\n')

const assertEnv = (env: Record<string, string>) => {
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable key: "${k}"`)
    if (v.includes('\0')) throw new Error(`Environment variable "${k}" contains a null byte`)
  }
}

export class DockerEnvRuntime implements EnvRuntime {
  constructor(private readonly docker: Dockerode = new Dockerode()) {}

  async ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    try {
      await this.docker.getVolume(name).inspect()
    } catch {
      await this.docker.createVolume({ Name: name, Labels: labels })
    }
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove({ force: true })
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err
    }
  }

  async startContainer(spec: EnvContainerSpec): Promise<string> {
    const c = await this.docker.createContainer({
      Image: spec.image,
      name: spec.name,
      User: ENV_USER,
      // Keep the container alive without the image's own entrypoint.
      Entrypoint: ['tail', '-f', '/dev/null'],
      Cmd: [],
      WorkingDir: WORKSPACE,
      Labels: spec.labels,
      Tty: false,
      HostConfig: {
        Memory: spec.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(spec.cpus * 1e9),
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Init: true,
        Mounts: [{ Type: 'volume', Source: spec.volume, Target: WORKSPACE }],
      },
    })
    try {
      await c.start()
    } catch (err) {
      await c.remove({ force: true }).catch(() => {})
      throw err
    }
    return c.id
  }

  async removeContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true })
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err
    }
  }

  async state(id: string): Promise<'running' | 'stopped' | 'missing'> {
    try {
      const info = await this.docker.getContainer(id).inspect()
      return info.State.Running ? 'running' : 'stopped'
    } catch {
      return 'missing'
    }
  }

  async exec(
    id: string,
    cmd: string[],
    opts: { env?: Record<string, string>; workdir?: string; timeoutMs: number; signal?: AbortSignal; onLine?: (line: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<ExecResult> {
    const env = opts.env ?? {}
    assertEnv(env)
    const container = this.docker.getContainer(id)
    // Record the wrapper shell's pid so cancel/timeout can kill its whole
    // process tree (Docker has no API to kill an exec). Portable across
    // GNU and BusyBox userlands: no setsid, just /proc children.
    const pidFile = `/tmp/routini-exec-${randomUUID()}.pid`
    const wrapped = ['bash', '-c', 'echo $$ > "$0"; "$@"', pidFile, ...cmd]
    const exec = await container.exec({
      Cmd: wrapped,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      User: ENV_USER,
      WorkingDir: opts.workdir ?? WORKSPACE,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    })
    const splitters = {
      stdout: lineSplitter((l) => opts.onLine?.(l, 'stdout')),
      stderr: lineSplitter((l) => opts.onLine?.(l, 'stderr')),
    }
    const stream = (await exec.start({ hijack: true, stdin: false })) as unknown as NodeJS.ReadableStream
    const demux = createDemuxer((kind, chunk) => splitters[kind].push(chunk))
    stream.on('data', (b: Buffer) => demux(b))

    let timedOut = false
    let aborted = false
    const kill = () => {
      void container
        .exec({ Cmd: ['bash', '-c', KILL_TREE, pidFile], User: ENV_USER })
        .then((k) => k.start({}))
        .catch(() => {})
    }
    const onAbort = () => {
      aborted = true
      kill()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)

    await new Promise<void>((resolve) => {
      stream.on('end', resolve)
      stream.on('close', resolve)
      stream.on('error', () => resolve())
    })
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
    splitters.stdout.flush()
    splitters.stderr.flush()
    const info = await exec.inspect().catch(() => null)
    return { exitCode: timedOut || aborted ? null : info?.ExitCode ?? null, timedOut, aborted }
  }

  async execTty(id: string, opts: { cols: number; rows: number; cmd?: string[] }): Promise<TtySession> {
    const exec = await this.docker.getContainer(id).exec({
      Cmd: opts.cmd ?? ['bash', '-l'],
      Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'],
      User: ENV_USER,
      WorkingDir: WORKSPACE,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })
    const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as Duplex
    await exec.resize({ h: opts.rows, w: opts.cols }).catch(() => {})
    const done = new Promise<number | null>((resolve) => {
      const finish = () => void exec.inspect().then((i) => resolve(i.ExitCode ?? null)).catch(() => resolve(null))
      stream.on('end', finish)
      stream.on('close', finish)
    })
    return {
      stream,
      resize: async (cols, rows) => {
        await exec.resize({ h: rows, w: cols }).catch(() => {})
      },
      done,
    }
  }

  async pull(image: string): Promise<void> {
    const stream = await this.docker.pull(image)
    await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())))
  }
}
