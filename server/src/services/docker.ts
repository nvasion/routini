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
    this.docker = docker ?? new Dockerode()
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

function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
