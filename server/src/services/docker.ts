/**
 * Docker Service
 *
 * Manages the full lifecycle of ephemeral Docker containers using the
 * Dockerode SDK.  Each container is created, started, waited on (with a
 * configurable timeout), and unconditionally removed on completion or failure.
 *
 * ─── Security controls applied to EVERY container ────────────────────────────
 *
 *   Field                       Value                   Purpose
 *   ─────────────────────────── ──────────────────────── ──────────────────────
 *   User                        "nobody" (default)       Non-root process user
 *   HostConfig.SecurityOpt      ["no-new-privileges:true"] Block setuid/setgid
 *   HostConfig.CapDrop          ["ALL"]  (default)       Remove all Linux caps
 *   HostConfig.Memory           512 MiB (default)        Prevent OOM on host
 *   HostConfig.NanoCpus         1 × 10⁹ (1 CPU, default) Prevent CPU starvation
 *   HostConfig.PidsLimit        512 (sandboxHostConfig)  Stop fork bombs
 *   HostConfig.Runtime          ROUTINI_CONTAINER_RUNTIME Optional gVisor (runsc)
 *   AutoRemove                  false (explicit remove)  Guaranteed cleanup
 *
 * All defaults are applied inside `runContainer` and are configurable via
 * `ContainerConfig` fields only to the extent explicitly exposed – the caller
 * cannot skip Security controls by omission.
 *
 * ─── Input sanitization ──────────────────────────────────────────────────────
 *
 *   Environment variable keys and values are validated before being forwarded
 *   to the Docker API: null bytes are rejected (they can corrupt daemon
 *   communication) and keys must be non-empty valid identifiers.
 *
 * ─── Log collection ──────────────────────────────────────────────────────────
 *
 *   After the container exits (or is killed), `container.logs()` is called
 *   with `follow: false` to retrieve the complete stdout+stderr buffer.
 *   The buffer is parsed with `parseDockerLogs` which demultiplexes Docker's
 *   8-byte frame protocol and prefixes stderr lines with `[stderr] `.
 *
 * The `Dockerode` client is accepted via the constructor to support
 * dependency injection in tests without a real Docker daemon.
 */

import Dockerode from 'dockerode'
import { dockerFromEnv, sandboxHostConfig } from './dockerClient.js'

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024  // 512 MiB
const DEFAULT_CPU_COUNT = 1
const DEFAULT_USER = 'nobody'
const DEFAULT_CAP_DROP: readonly string[] = ['ALL']

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for a single container run. */
export interface ContainerConfig {
  /** Docker image to pull and run. */
  image: string
  /** Unique container name (analogous to `docker run --name`). */
  name: string
  /** Key-value environment variables injected into the container. */
  env: Record<string, string>
  /** Memory limit in bytes.  Default: 512 MiB. */
  memoryBytes?: number
  /** Number of CPUs to allocate (may be fractional).  Default: 1. */
  cpuCount?: number
  /** User to run the container process as.  Default: `'nobody'`. */
  user?: string
  /** Linux capabilities to drop.  Default: `['ALL']`. */
  capDrop?: string[]
}

/** Structured result returned after a container run. */
export interface ContainerLifecycleResult {
  /**
   * Docker-assigned container ID truncated to 12 hex characters.
   * Empty string if the container could not be created.
   */
  containerId: string
  /** Process exit code, or `null` if the container was killed / never exited. */
  exitCode: number | null
  /** Combined stdout + stderr log lines collected after the container exits. */
  logs: string[]
  /** `true` if the container was force-killed because `timeoutMs` elapsed. */
  timedOut: boolean
  /**
   * Human-readable error message describing an infrastructure failure
   * (e.g. image not found, daemon unreachable).  Absent on normal exit
   * (including non-zero exit codes).
   */
  error?: string
}

// ── Log parsing ──────────────────────────────────────────────────────────────

/**
 * Parses Docker's multiplexed log-stream format into plain text lines.
 *
 * When a container is created without a TTY, Docker multiplexes stdout and
 * stderr into a single byte stream using 8-byte frame headers:
 *
 *   Byte 0:     stream type  (1 = stdout, 2 = stderr)
 *   Bytes 1–3:  zero padding
 *   Bytes 4–7:  payload length as a big-endian uint32
 *
 * Empty lines are skipped.  Stderr lines are prefixed with `[stderr] `.
 *
 * Exported for isolated unit testing.
 */
export function parseDockerLogs(buf: Buffer, out: string[]): void {
  let offset = 0
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset]
    const size = buf.readUInt32BE(offset + 4)
    offset += 8

    if (size === 0) continue
    if (offset + size > buf.length) break

    const payload = buf.subarray(offset, offset + size).toString('utf8')
    offset += size

    const prefix = streamType === 2 ? '[stderr] ' : ''
    for (const line of payload.split('\n')) {
      if (line.trim()) out.push(`${prefix}${line}`)
    }
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Orchestrates Docker container lifecycle via the Dockerode SDK.
 *
 * Lifecycle performed by `runContainer`:
 *   1. Create the container with security + resource constraints.
 *   2. Start the container.
 *   3. Race `container.wait()` against `timeoutMs`.
 *   4. Kill the container if the timeout fires first.
 *   5. Collect logs via `container.logs()`.
 *   6. Remove the container unconditionally (force = true).
 */
export class DockerService {
  private readonly docker: Dockerode

  /**
   * @param docker  Optional Dockerode instance.  When omitted a new instance
   *                is created using the default socket path (`/var/run/docker.sock`).
   *                Pass a mock in tests to avoid requiring a real daemon.
   */
  constructor(docker?: Dockerode) {
    this.docker = docker ?? dockerFromEnv()
  }

  async runContainer(
    config: ContainerConfig,
    timeoutMs: number
  ): Promise<ContainerLifecycleResult> {
    const {
      image,
      name,
      env,
      memoryBytes = DEFAULT_MEMORY_BYTES,
      cpuCount = DEFAULT_CPU_COUNT,
      user = DEFAULT_USER,
      capDrop = [...DEFAULT_CAP_DROP],
    } = config

    // ── Sanitize env vars ────────────────────────────────────────────
    // Null bytes corrupt the Docker daemon wire protocol; newlines in a
    // key would create a second key=value pair on some daemon versions.
    // Reject them early rather than relying on daemon error messages.
    for (const [k, v] of Object.entries(env)) {
      if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new Error(`Invalid environment variable key: "${k}"`)
      }
      if (v.includes('\0')) {
        throw new Error(`Environment variable "${k}" contains a null byte`)
      }
    }

    const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`)
    let container: Dockerode.Container | undefined

    // ── 1. Create container ──────────────────────────────────────────
    try {
      container = await this.docker.createContainer({
        Image: image,
        name,
        User: user,
        Env: envArray,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          Memory: memoryBytes,
          NanoCpus: Math.round(cpuCount * 1e9),
          CapDrop: capDrop,
          SecurityOpt: ['no-new-privileges:true'],
          ...sandboxHostConfig(),
          AutoRemove: false,  // We manage removal explicitly for full control.
        },
      })
    } catch (err) {
      return {
        containerId: '',
        exitCode: null,
        logs: [],
        timedOut: false,
        error: `Failed to create container: ${toErrMsg(err)}`,
      }
    }

    const containerId = container.id.slice(0, 12)

    // ── 2. Start container ───────────────────────────────────────────
    try {
      await container.start()
    } catch (err) {
      await this.forceRemove(container)
      return {
        containerId,
        exitCode: null,
        logs: [],
        timedOut: false,
        error: `Failed to start container: ${toErrMsg(err)}`,
      }
    }

    // ── 3–4. Wait for exit or timeout ────────────────────────────────
    let timedOut = false
    let exitCode: number | null = null

    try {
      const outcome = await Promise.race([
        container
          .wait()
          .then((r: { StatusCode: number }) => ({ kind: 'done' as const, code: r.StatusCode })),
        new Promise<{ kind: 'timeout' }>(resolve =>
          setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        ),
      ])

      if (outcome.kind === 'timeout') {
        timedOut = true
        // Best-effort kill; container may have already exited.
        try { await container.kill() } catch { /* ignore */ }
      } else {
        exitCode = outcome.code
      }
    } catch {
      // wait() may throw if the daemon becomes unreachable; treat as unknown failure.
      exitCode = null
    }

    // ── 5. Collect logs ──────────────────────────────────────────────
    const logs: string[] = []
    try {
      const buf = await container.logs({
        stdout: true,
        stderr: true,
        follow: false,
        timestamps: false,
      })
      parseDockerLogs(buf, logs)
    } catch {
      // Best-effort – container may already be gone.
    }

    // ── 6. Remove container ──────────────────────────────────────────
    await this.forceRemove(container)

    return { containerId, exitCode, logs, timedOut }
  }

  /**
   * Runs a container and streams its output line by line while it runs.
   * Attaches before start so no output is missed. Same security defaults as
   * runContainer. The container is killed on `signal` abort or timeout and
   * always removed afterwards.
   */
  async runStreaming(
    config: ContainerConfig & { labels?: Record<string, string>; network?: string },
    opts: { timeoutMs: number; signal?: AbortSignal; onLine: (line: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<ContainerLifecycleResult & { aborted: boolean }> {
    const { image, name, env, memoryBytes = DEFAULT_MEMORY_BYTES, cpuCount = DEFAULT_CPU_COUNT, user = DEFAULT_USER, capDrop = [...DEFAULT_CAP_DROP] } = config
    for (const [k, v] of Object.entries(env)) {
      if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable key: "${k}"`)
      if (v.includes('\0')) throw new Error(`Environment variable "${k}" contains a null byte`)
    }
    const empty = { logs: [] as string[], timedOut: false, aborted: false, exitCode: null }

    let container: Dockerode.Container
    try {
      container = await this.docker.createContainer({
        Image: image,
        name,
        User: user,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: config.labels,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {
          ...(config.network ? { NetworkMode: config.network } : {}),
          Memory: memoryBytes,
          NanoCpus: Math.round(cpuCount * 1e9),
          CapDrop: capDrop,
          SecurityOpt: ['no-new-privileges:true'],
          ...sandboxHostConfig(),
          AutoRemove: false,
        },
      })
    } catch (err) {
      return { ...empty, containerId: '', error: `Failed to create container: ${toErrMsg(err)}` }
    }
    const containerId = container.id.slice(0, 12)

    const splitters = {
      stdout: lineSplitter((l) => opts.onLine(l, 'stdout')),
      stderr: lineSplitter((l) => opts.onLine(l, 'stderr')),
    }
    try {
      const stream = (await container.attach({ stream: true, stdout: true, stderr: true })) as NodeJS.ReadableStream
      const demux = createDemuxer((kind, chunk) => splitters[kind].push(chunk))
      stream.on('data', (b: Buffer) => demux(b))
      await container.start()
    } catch (err) {
      await this.forceRemove(container)
      return { ...empty, containerId, error: `Failed to start container: ${toErrMsg(err)}` }
    }

    let timedOut = false
    let aborted = false
    let exitCode: number | null = null
    const kill = async () => {
      try {
        await container.kill()
      } catch {
        /* already exited */
      }
    }
    const onAbort = () => {
      aborted = true
      void kill()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    const timer = setTimeout(() => {
      timedOut = true
      void kill()
    }, opts.timeoutMs)
    try {
      const r = (await container.wait()) as { StatusCode: number }
      exitCode = timedOut || aborted ? null : r.StatusCode
    } catch {
      exitCode = null
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    // Give the attach stream a moment to deliver its last frames.
    await new Promise((r) => setTimeout(r, 50))
    splitters.stdout.flush()
    splitters.stderr.flush()
    await this.forceRemove(container)
    return { containerId, exitCode, logs: [], timedOut, aborted }
  }

  /** Kills and removes every container carrying all of `labels`. Returns how many. */
  async killByLabels(labels: Record<string, string>): Promise<number> {
    const filters = { label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) }
    let list: Array<{ Id: string }> = []
    try {
      list = await this.docker.listContainers({ all: true, filters })
    } catch {
      return 0
    }
    for (const c of list) await this.forceRemove(this.docker.getContainer(c.Id))
    return list.length
  }

  /** Removes a container, silencing errors (it may already be removed). */
  private async forceRemove(container: Dockerode.Container): Promise<void> {
    try {
      await container.remove({ force: true })
    } catch {
      // Intentionally swallowed – the container may not exist.
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Incremental parser for Docker's multiplexed attach stream (8-byte frame
 * headers; see parseDockerLogs). Frames may arrive split across chunks.
 */
export function createDemuxer(onFrame: (stream: 'stdout' | 'stderr', payload: Buffer) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4)
      if (pending.length < 8 + size) break
      const kind = pending[0] === 2 ? 'stderr' : 'stdout'
      onFrame(kind, pending.subarray(8, 8 + size))
      pending = pending.subarray(8 + size)
    }
  }
}

/** Buffers bytes and emits complete lines (without the newline). Very long lines are emitted in pieces. */
export function lineSplitter(onLine: (line: string) => void, maxLine = 64 * 1024): { push(b: Buffer): void; flush(): void } {
  let buf = ''
  const decoder = new TextDecoder()
  return {
    push(b) {
      buf += decoder.decode(b, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
      while (buf.length > maxLine) {
        onLine(buf.slice(0, maxLine))
        buf = buf.slice(maxLine)
      }
    },
    flush() {
      buf += decoder.decode()
      if (buf.trim()) onLine(buf)
      buf = ''
    },
  }
}

function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
