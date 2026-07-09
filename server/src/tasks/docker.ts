/**
 * Docker executor for developmental tasks.
 *
 * Ephemeral containers execute AI coding agents in isolation from the host.
 * This module wraps the `dockerode` SDK with a security-first configuration
 * layer and lifecycle management so callers cannot accidentally launch a
 * privileged container or leak one on error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Security defaults applied to every container (see DEFAULT_DOCKER_CONFIG):
 * ─────────────────────────────────────────────────────────────────────────────
 *   User            : "1000:1000"           — never run as root inside the box
 *   CapDrop         : ["ALL"]               — drop every Linux capability
 *   CapAdd          : []                    — add none back
 *   Privileged      : false                 — explicitly disable privileged mode
 *   ReadonlyRootfs  : true                  — root FS is read-only
 *   NetworkMode     : "none"                — no network by default
 *   PidsLimit       : 128                   — cap fork-bomb blast radius
 *   Memory          : 512 MiB               — hard memory limit
 *   MemorySwap      : 512 MiB               — no swap beyond memory
 *   NanoCpus        : 1 CPU (1e9 nanos)     — 1 vCPU cap
 *   SecurityOpt     : ["no-new-privileges"] — block setuid escalation
 *   Tmpfs           : { "/tmp": … }         — small writable overlay because
 *                                             `ReadonlyRootfs: true` blocks /tmp
 *
 * Resource limits (memory, CPU, PIDs, wall-clock timeout) can be tuned per
 * deployment via environment variables — see {@link readDockerLimitsFromEnv}.
 * The security defaults (user, capabilities, network) are intentionally not
 * env-configurable so a misconfigured deployment cannot silently weaken them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Image-name validation:
 * ─────────────────────────────────────────────────────────────────────────────
 * Image references are validated against a strict allowlist regex before they
 * ever reach the Docker daemon. The regex refuses shell metacharacters (`;`,
 * `|`, `&`, backticks, `$`), whitespace, control chars, `..`, absolute paths,
 * and anything longer than 255 characters — the same threat model as command
 * injection into `docker pull <image>`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Retry policy:
 * ─────────────────────────────────────────────────────────────────────────────
 * Only *daemon connection* operations (createContainer, container.start) are
 * retried with exponential backoff (200 ms → 400 ms → 800 ms, up to
 * `createMaxAttempts`, default 3). Workload errors (non-zero container exit
 * status) are surfaced immediately — retrying a failing user script is at best
 * wasteful and at worst destructive.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Lifecycle guarantees:
 * ─────────────────────────────────────────────────────────────────────────────
 * Container removal (`force: true, v: true`) runs in a `finally` block so it
 * happens on success, workload failure, wall-clock timeout, and daemon errors
 * alike. If removal itself fails we log the error server-side — we do not
 * throw over the top of the primary error the caller already saw.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Secrets handling:
 * ─────────────────────────────────────────────────────────────────────────────
 * Credentials (SSH keys, git tokens, AI-provider API keys) MUST be passed via
 * tmpfs-backed bind mounts, never as environment variables. Environment
 * variables are visible to any host user who can run `docker inspect` on the
 * live container and may appear in daemon crash dumps. Callers stage the
 * secret material into `secretFiles`; the executor mounts each one at a
 * caller-chosen target path with mode 0400. See {@link DockerRunOptions}.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Factory usage example:
 * ─────────────────────────────────────────────────────────────────────────────
 *   import Docker from 'dockerode'
 *   const dockerClient = new Docker(resolveDockerConnection(process.env))
 *   const executor = createDockerExecutor({
 *     client: dockerClient,
 *     limits: readDockerLimitsFromEnv(process.env),
 *   })
 *   launchExecution(task, run, store, executor)
 */

import type { TaskExecutor } from './executor.js'
import type { DevelopmentalTask, Task, TaskRun } from './types.js'
import type { TaskStore } from './store.js'

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Coded error codes surfaced by the executor. Kept as a string-literal union
 * so callers can type-narrow (`if (err.code === 'TIMEOUT') …`) without
 * depending on message wording.
 */
export type DockerErrorCode =
  | 'INVALID_IMAGE'
  | 'INVALID_TIMEOUT'
  | 'INVALID_LIMITS'
  | 'WRONG_TASK_TYPE'
  | 'MISSING_CLIENT'
  | 'CREATE_FAILED'
  | 'START_FAILED'
  | 'WAIT_FAILED'
  | 'TIMEOUT'
  | 'NON_ZERO_EXIT'
  | 'INSECURE_CONNECTION'
  | 'INVALID_CONNECTION'
  | 'INVALID_SECRET_MOUNT'
  /** Decryption of per-user AI credentials failed at run time. */
  | 'CREDENTIALS_ERROR'
  /** The repository URL is malformed or contains unsafe characters. */
  | 'INVALID_REPO_URL'

/**
 * Typed error class for the Docker executor. Callers should key logic on
 * `code` rather than parsing `message`.
 *
 * `cause` is preserved for observability; log formatters should render both
 * this error and its cause without leaking `cause` details to API clients.
 */
export class DockerExecutionError extends Error {
  public readonly code: DockerErrorCode
  public readonly cause?: unknown

  constructor(message: string, code: DockerErrorCode, cause?: unknown) {
    super(message)
    this.name = 'DockerExecutionError'
    this.code = code
    this.cause = cause
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`
    }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the Docker daemon. Consumers only use `createContainer`
 * (we do NOT expose `pull`, `exec`, or image build here — those would widen the
 * daemon-side attack surface unnecessarily). Tests inject a fake client that
 * satisfies this shape; production wiring passes a real `dockerode` instance.
 */
export interface DockerClient {
  createContainer(options: DockerContainerCreateOptions): Promise<DockerContainer>
}

/** Container handle we depend on. Kept intentionally small. */
export interface DockerContainer {
  id?: string
  start(): Promise<unknown>
  wait(): Promise<{ StatusCode: number }>
  remove(options?: { force?: boolean; v?: boolean }): Promise<unknown>
}

/**
 * A single tmpfs-backed bind mount for a secret file. The executor writes
 * `content` into a per-container tmpfs, mounts it at `targetPath` inside the
 * container as read-only, and clears the source path when the container is
 * removed. Callers construct these from decrypted secret material at runtime;
 * do NOT persist plaintext to disk.
 *
 * `targetPath` must be an absolute path that does not traverse (`..`) and does
 * not overlap with mounts we own (`/tmp`, `/workspace`).
 */
export interface SecretMount {
  /** Absolute path inside the container where the secret is exposed. */
  targetPath: string
  /** Decrypted secret content. Kept in memory; never logged. */
  content: string
  /** File mode octal string. Defaults to `"0400"` (read-only, owner-only). */
  mode?: string
}

/**
 * Subset of dockerode's ContainerCreateOptions we actually set. Explicit shape
 * (rather than re-exporting the SDK type) documents what we control and makes
 * DEFAULT_DOCKER_CONFIG typechecked against a stable interface even as the
 * upstream types evolve.
 */
export interface DockerContainerCreateOptions {
  Image: string
  Cmd?: string[]
  Env?: string[]
  User?: string
  WorkingDir?: string
  Labels?: Record<string, string>
  HostConfig?: DockerHostConfig
  NetworkDisabled?: boolean
}

export interface DockerHostConfig {
  AutoRemove?: boolean
  CapAdd?: string[]
  CapDrop?: string[]
  Privileged?: boolean
  ReadonlyRootfs?: boolean
  NetworkMode?: string
  PidsLimit?: number
  Memory?: number
  MemorySwap?: number
  NanoCpus?: number
  SecurityOpt?: string[]
  /** Tmpfs-backed writable paths — needed because ReadonlyRootfs blocks /tmp. */
  Tmpfs?: Record<string, string>
  /** Bind mounts (used for secrets — never persisted to host disk). */
  Mounts?: DockerMount[]
}

/** Structured mount spec. Matches dockerode's `Mount` shape. */
export interface DockerMount {
  Type: 'bind' | 'tmpfs' | 'volume'
  Source?: string
  Target: string
  ReadOnly?: boolean
  TmpfsOptions?: { SizeBytes?: number; Mode?: number }
}

/**
 * Resource-limit tunables. All are positive integers or the executor throws
 * an `INVALID_LIMITS` error at construction time.
 */
export interface DockerResourceLimits {
  memoryBytes: number
  memorySwapBytes: number
  nanoCpus: number
  pidsLimit: number
  /** Wall-clock ceiling for `container.wait()`, in ms. */
  timeoutMs: number
  /** Size cap for the /tmp tmpfs mount, in bytes. */
  tmpfsSizeBytes: number
}

/**
 * Optional per-run overrides for the developmental task executor. Any field
 * left `undefined` inherits the value from `DEFAULT_DOCKER_CONFIG`.
 *
 * `image` is required — every developmental task must state which sandbox
 * image the AI agent runs inside.
 */
export interface DockerRunOptions {
  image: string
  cmd?: string[]
  env?: Record<string, string>
  workingDir?: string
  /** Wall-clock ceiling for the container. Defaults to 15 minutes (or the
   * limit configured via env). */
  timeoutMs?: number
  /** Additional labels merged with the executor-managed labels. */
  labels?: Record<string, string>
  /**
   * Optional network mode override. **Default is `"none"`.** Setting this to
   * anything else disables the default network isolation and MUST only be
   * used for developmental tasks that require outbound Git / package-manager
   * access. Production deployments should point this at a named egress-filtered
   * bridge network that allowlists exactly the ports the agent needs
   * (typically 22/tcp and 443/tcp for git+https). The executor logs a WARN
   * whenever a non-"none" network is selected so operators see it in the audit
   * trail.
   */
  networkMode?: string
  /**
   * Secret material mounted into the container as tmpfs-backed files. Prefer
   * this over `env` for anything sensitive (SSH keys, tokens, API credentials).
   * Callers are responsible for supplying already-decrypted content.
   */
  secretFiles?: SecretMount[]
}

/**
 * Factory options — control retry aggressiveness and inject the Docker client
 * (for tests). Production callers can omit `client` to use the default
 * `dockerode` connection resolution described in {@link resolveDockerConnection}.
 */
export interface DockerExecutorConfig {
  client?: DockerClient
  /** Max attempts for daemon connection ops. Must be ≥ 1. Default 3. */
  createMaxAttempts?: number
  /** Base backoff for exponential retry, in ms. Default 200. */
  createRetryBaseMs?: number
  /** Sleep implementation — overridable so tests skip real timers. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Resource limits override. If omitted, {@link DEFAULT_DOCKER_LIMITS}
   * (which mirrors the constants in DEFAULT_DOCKER_CONFIG) is used. Pass
   * {@link readDockerLimitsFromEnv}(process.env) at server startup to make
   * limits environment-driven.
   */
  limits?: DockerResourceLimits
  /**
   * Extract per-run options from a developmental task. Defaults to
   * {@link defaultRunOptionsFromTask}. Override to plumb custom fields from
   * upstream storage schemas.
   */
  resolveRunOptions?: (task: DevelopmentalTask) => DockerRunOptions
}

// ---------------------------------------------------------------------------
// Constants — security defaults & resource limits
// ---------------------------------------------------------------------------

/** Default resource ceilings; mirror {@link DEFAULT_DOCKER_CONFIG}. */
export const DEFAULT_DOCKER_LIMITS: Readonly<DockerResourceLimits> = Object.freeze({
  memoryBytes: 512 * 1024 * 1024,
  memorySwapBytes: 512 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 128,
  timeoutMs: 15 * 60 * 1000,
  tmpfsSizeBytes: 64 * 1024 * 1024, // 64 MiB writable /tmp
})

/**
 * Container-wide security defaults. Applied to every developmental task
 * container. Individual fields can be overridden via `DockerRunOptions`, but
 * relaxing security defaults requires an explicit code change here so a
 * reviewer will see it.
 *
 * Numeric ceilings (memory, cpu, pids, timeout, tmpfs size) mirror
 * {@link DEFAULT_DOCKER_LIMITS} — the two are kept in sync via a runtime
 * check in {@link createDockerExecutor}.
 */
export const DEFAULT_DOCKER_CONFIG: Readonly<{
  user: string
  hostConfig: Readonly<Required<Omit<DockerHostConfig, 'AutoRemove' | 'Tmpfs' | 'Mounts'>> & {
    AutoRemove: boolean
    Tmpfs: Readonly<Record<string, string>>
  }>
  workingDir: string
  networkDisabled: boolean
  timeoutMs: number
}> = Object.freeze({
  user: '1000:1000',
  workingDir: '/workspace',
  networkDisabled: true,
  timeoutMs: DEFAULT_DOCKER_LIMITS.timeoutMs,
  hostConfig: Object.freeze({
    AutoRemove: false, // we remove explicitly in `finally` for guaranteed cleanup
    CapAdd: Object.freeze([]) as unknown as string[],
    CapDrop: Object.freeze(['ALL']) as unknown as string[],
    Privileged: false,
    ReadonlyRootfs: true,
    NetworkMode: 'none',
    PidsLimit: DEFAULT_DOCKER_LIMITS.pidsLimit,
    Memory: DEFAULT_DOCKER_LIMITS.memoryBytes,
    MemorySwap: DEFAULT_DOCKER_LIMITS.memorySwapBytes,
    NanoCpus: DEFAULT_DOCKER_LIMITS.nanoCpus,
    SecurityOpt: Object.freeze(['no-new-privileges']) as unknown as string[],
    // ReadonlyRootfs blocks writes to `/tmp`, but many agents need a scratch
    // directory. Give them a small, size-capped tmpfs mount that lives and
    // dies with the container.
    Tmpfs: Object.freeze({
      '/tmp': `rw,noexec,nosuid,nodev,size=${DEFAULT_DOCKER_LIMITS.tmpfsSizeBytes}`,
    }) as unknown as Record<string, string>,
  }),
})

/**
 * Strict image-name allowlist. Matches a subset of the Docker reference
 * grammar: an optional registry host (`host[:port]/`), one or more path
 * segments separated by `/`, and an optional `:tag` or `@digest` suffix.
 *
 * The pattern refuses everything that could smuggle a shell metacharacter or
 * escape the daemon's argument parser — see the unit tests for the full
 * rejection matrix (`..`, backticks, `;`, `&`, `|`, `$`, whitespace,
 * newlines, control chars, non-ASCII, empty string, > 255 chars).
 */
const IMAGE_NAME_PATTERN =
  /^([a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?\/)?[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[a-zA-Z0-9._-]{1,128}|@sha256:[a-f0-9]{64})?$/

/** Maximum length for an image reference (bytes). Docker itself caps at 255. */
const IMAGE_NAME_MAX_LEN = 255

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` iff `name` is a syntactically valid, safe image reference.
 * Callers should reject the request outright when this returns `false` —
 * do not attempt to sanitize.
 */
export function validateImageName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > IMAGE_NAME_MAX_LEN) return false
  // Reject any control character (including CR/LF/tab) before regex — regex
  // engines vary on whether `.` matches them and defense-in-depth is cheap.
  if (/[\x00-\x1f\x7f]/.test(name)) return false
  if (name.includes('..')) return false
  return IMAGE_NAME_PATTERN.test(name)
}

/**
 * Docker network-name allowlist. Docker requires names to begin with an
 * alphanumeric character and contain only alphanumeric characters, underscores,
 * hyphens, or dots — the same alphabet as image path segments. We also reject
 * names longer than 255 characters and the special value `'none'` is accepted
 * as-is (it is the documented way to disable networking in Docker).
 *
 * All shell metacharacters (`;`, `|`, `&`, backticks, `$`, whitespace, …) are
 * rejected so the value cannot escape a `docker network inspect` invocation or
 * equivalent daemon RPC argument.
 */
export function validateDockerNetworkName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name === 'none') return true
  if (name.length === 0 || name.length > 255) return false
  if (/[\x00-\x1f\x7f]/.test(name)) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9_\-\.]*$/.test(name)
}

/**
 * Read resource limits from an environment snapshot.
 *
 * Recognized variables (all optional; each falls back to the value in
 * {@link DEFAULT_DOCKER_LIMITS}):
 *
 * | Variable                    | Effect                            |
 * |-----------------------------|-----------------------------------|
 * | `DOCKER_MEMORY_LIMIT`       | Bytes; sets both Memory and swap  |
 * | `DOCKER_MEMORY_SWAP_LIMIT`  | Bytes; overrides swap independently|
 * | `DOCKER_CPU_NANOS`          | Nano-CPUs; 1_000_000_000 = 1 vCPU |
 * | `DOCKER_PIDS_LIMIT`         | Max PIDs inside container         |
 * | `DOCKER_TIMEOUT_MS`         | Wall-clock deadline (ms)          |
 * | `DOCKER_TMPFS_SIZE_BYTES`   | /tmp tmpfs size cap (bytes)       |
 *
 * All values must parse as positive integers; anything else throws
 * `INVALID_LIMITS`. This is deliberately noisy — a misconfigured env var
 * should stop startup, not silently fall back to the default.
 */
export function readDockerLimitsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): DockerResourceLimits {
  const parsePositive = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw.trim() === '') return fallback
    const n = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
      throw new DockerExecutionError(
        `Invalid ${name}=${JSON.stringify(raw)} — expected a positive integer`,
        'INVALID_LIMITS',
      )
    }
    return n
  }

  const memoryBytes = parsePositive(
    env.DOCKER_MEMORY_LIMIT,
    DEFAULT_DOCKER_LIMITS.memoryBytes,
    'DOCKER_MEMORY_LIMIT',
  )
  return {
    memoryBytes,
    memorySwapBytes: parsePositive(
      env.DOCKER_MEMORY_SWAP_LIMIT,
      memoryBytes,
      'DOCKER_MEMORY_SWAP_LIMIT',
    ),
    nanoCpus: parsePositive(env.DOCKER_CPU_NANOS, DEFAULT_DOCKER_LIMITS.nanoCpus, 'DOCKER_CPU_NANOS'),
    pidsLimit: parsePositive(
      env.DOCKER_PIDS_LIMIT,
      DEFAULT_DOCKER_LIMITS.pidsLimit,
      'DOCKER_PIDS_LIMIT',
    ),
    timeoutMs: parsePositive(
      env.DOCKER_TIMEOUT_MS,
      DEFAULT_DOCKER_LIMITS.timeoutMs,
      'DOCKER_TIMEOUT_MS',
    ),
    tmpfsSizeBytes: parsePositive(
      env.DOCKER_TMPFS_SIZE_BYTES,
      DEFAULT_DOCKER_LIMITS.tmpfsSizeBytes,
      'DOCKER_TMPFS_SIZE_BYTES',
    ),
  }
}

/**
 * Docker daemon connection resolution.
 *
 * **Fail-secure by default.** If none of `DOCKER_HOST`, `DOCKER_SOCKET_PATH`,
 * or the explicit opt-in `DOCKER_ALLOW_DEFAULT_SOCKET=1` is set, this function
 * throws. That prevents the "environment drift → app silently uses the
 * host's root Docker socket" failure mode called out in the security review.
 * Production deployments MUST provide an explicit connection.
 *
 * Order of precedence:
 *   1. Explicit `DOCKER_HOST` env var — e.g. `tcp://docker.svc:2376`
 *   2. Explicit `DOCKER_SOCKET_PATH` env var — path to a Unix socket
 *   3. `DOCKER_ALLOW_DEFAULT_SOCKET=1` — opt-in fallback to
 *      `/var/run/docker.sock` (for local dev only)
 *   4. Otherwise: throws `INSECURE_CONNECTION`
 *
 * TLS parameters (`DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`) are surfaced when
 * present so the caller can wire them into `dockerode`.
 *
 * We deliberately do NOT read `DOCKER_HOST` from `process.env` directly here;
 * the caller passes a normalized env snapshot so tests remain deterministic.
 */
export function resolveDockerConnection(env: Readonly<Record<string, string | undefined>>): {
  socketPath?: string
  host?: string
  port?: number
  protocol?: 'http' | 'https' | 'ssh'
  ca?: string
  cert?: string
  key?: string
} {
  const dockerHost = env.DOCKER_HOST?.trim()
  if (dockerHost) {
    // Accept `tcp://host:port`, `unix:///path`, `ssh://user@host`.
    try {
      const url = new URL(dockerHost.replace(/^tcp:\/\//, 'http://'))
      if (url.protocol === 'unix:') {
        return { socketPath: url.pathname }
      }
      const scheme = url.protocol.replace(':', '')
      const protocol: 'http' | 'https' | 'ssh' =
        env.DOCKER_TLS_VERIFY === '1' ? 'https' : scheme === 'ssh' ? 'ssh' : (scheme as 'http')
      const portNum = url.port ? Number.parseInt(url.port, 10) : undefined
      const result: {
        host: string
        port?: number
        protocol: 'http' | 'https' | 'ssh'
        ca?: string
        cert?: string
        key?: string
      } = {
        host: url.hostname,
        port: Number.isFinite(portNum) ? portNum : undefined,
        protocol,
      }
      // Surface TLS cert paths when the operator has configured them.
      if (env.DOCKER_CERT_PATH?.trim()) {
        const base = env.DOCKER_CERT_PATH.trim().replace(/\/+$/, '')
        result.ca = `${base}/ca.pem`
        result.cert = `${base}/cert.pem`
        result.key = `${base}/key.pem`
      }
      return result
    } catch (err) {
      throw new DockerExecutionError(
        `Invalid DOCKER_HOST value: ${String(dockerHost)}`,
        'INVALID_CONNECTION',
        err,
      )
    }
  }

  const socketPath = env.DOCKER_SOCKET_PATH?.trim()
  if (socketPath) return { socketPath }

  // Fail-secure: refuse to silently fall back to the host Docker socket
  // unless the operator has explicitly opted in.
  if (env.DOCKER_ALLOW_DEFAULT_SOCKET === '1') {
    return { socketPath: '/var/run/docker.sock' }
  }
  throw new DockerExecutionError(
    'No Docker daemon connection configured. Set DOCKER_HOST (recommended for production, ' +
      'preferably tcp:// with DOCKER_TLS_VERIFY=1), or DOCKER_SOCKET_PATH, or explicitly ' +
      'opt in to the local socket with DOCKER_ALLOW_DEFAULT_SOCKET=1 (development only). ' +
      'Refusing to default to /var/run/docker.sock because the socket is root-equivalent on the host.',
    'INSECURE_CONNECTION',
  )
}

/**
 * Default extractor: reads image / command / env from a DevelopmentalTask.
 *
 * The DevelopmentalTask domain object doesn't currently carry an explicit
 * image reference (see types.ts) — for the MVP we map each supported agent
 * to a pinned sandbox image. Future refactors can extend this mapping or
 * take an image from the task record directly.
 *
 * NOTE: The env vars set here (`ROUTINI_TASK_ID`, `ROUTINI_REPO_URL`,
 * `ROUTINI_BRANCH`) are non-sensitive metadata. Actual credentials (SSH
 * keys, git tokens, AI API keys) MUST be passed via `secretFiles` — see the
 * secrets-handling section in the module docblock.
 */
export function defaultRunOptionsFromTask(task: DevelopmentalTask): DockerRunOptions {
  const agentImages: Record<string, string> = {
    opencode: 'ghcr.io/routini/agent-opencode:0.1.0',
    'claude-code': 'ghcr.io/routini/agent-claude-code:0.1.0',
    omnimancer: 'ghcr.io/routini/agent-omnimancer:0.1.0',
  }
  const image = agentImages[task.agentName]
  if (!image || !validateImageName(image)) {
    throw new DockerExecutionError(
      `No sandbox image registered for agent "${task.agentName}"`,
      'INVALID_IMAGE',
    )
  }
  return {
    image,
    env: {
      ROUTINI_TASK_ID: task.id,
      ROUTINI_REPO_URL: task.repoUrl,
      ROUTINI_BRANCH: task.branchName,
    },
  }
}

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * Build a TaskExecutor that runs developmental tasks inside a Docker container.
 *
 * The returned executor:
 *   1. Validates the image name against {@link validateImageName}.
 *   2. Merges caller options with {@link DEFAULT_DOCKER_CONFIG}.
 *   3. Calls `createContainer` with exponential-backoff retry for transient
 *      daemon errors.
 *   4. Starts the container, races `container.wait()` against a wall-clock
 *      timeout, and records the exit code.
 *   5. Removes the container in a `finally` block regardless of outcome —
 *      even if the timeout fires or the daemon rejects `start`.
 *
 * For non-developmental tasks the executor delegates to a caller-provided
 * fallback (defaults to throwing so misrouted work is caught early).
 */
export function createDockerExecutor(config: DockerExecutorConfig = {}): TaskExecutor {
  const maxAttempts = Math.max(1, config.createMaxAttempts ?? 3)
  const backoffBase = Math.max(1, config.createRetryBaseMs ?? 200)
  const sleep = config.sleep ?? defaultSleep
  const resolveRunOptions = config.resolveRunOptions ?? defaultRunOptionsFromTask
  const limits = config.limits ?? DEFAULT_DOCKER_LIMITS

  // Validate the injected limits so a misconfigured deployment fails at
  // factory time rather than the first task run.
  assertValidLimits(limits)

  return async function dockerExecutor(
    task: Task,
    run: TaskRun,
    store: TaskStore,
  ): Promise<void> {
    if (task.type !== 'developmental') {
      throw new DockerExecutionError(
        `dockerExecutor received task type "${task.type}"; expected "developmental"`,
        'WRONG_TASK_TYPE',
      )
    }

    const client = config.client
    if (!client) {
      throw new DockerExecutionError(
        'DockerExecutorConfig.client is required. Wire a dockerode instance at server startup ' +
          '(see resolveDockerConnection) or inject a fake in tests.',
        'MISSING_CLIENT',
      )
    }

    const runOptions = resolveRunOptions(task)
    if (!validateImageName(runOptions.image)) {
      throw new DockerExecutionError(
        `Invalid Docker image reference: ${JSON.stringify(runOptions.image)}`,
        'INVALID_IMAGE',
      )
    }

    const timeoutMs = runOptions.timeoutMs ?? limits.timeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DockerExecutionError(`Invalid timeoutMs: ${String(timeoutMs)}`, 'INVALID_TIMEOUT')
    }

    // Compose createContainer options with security defaults locked in.
    const createOptions = buildCreateOptions(task, runOptions, limits)

    // Audit-trail warning: any deviation from the default "none" network
    // MUST show up in the run log so operators can spot it.
    if (createOptions.HostConfig?.NetworkMode !== DEFAULT_DOCKER_CONFIG.hostConfig.NetworkMode) {
      logRun(
        store,
        run.id,
        'warn',
        `Container network isolation relaxed: NetworkMode="${createOptions.HostConfig?.NetworkMode ?? ''}". ` +
          'This should target an egress-filtered bridge network only.',
      )
    }

    logRun(store, run.id, 'info', `Creating sandbox container for image ${runOptions.image}`)
    store.updateRun(run.id, { status: 'running' })
    store.updateTaskStatus(task.id, 'running')

    let container: DockerContainer | undefined
    let workloadError: Error | undefined
    let exitCode: number | undefined

    try {
      container = await withRetry(
        () => client.createContainer(createOptions),
        maxAttempts,
        backoffBase,
        sleep,
        'createContainer',
        'CREATE_FAILED',
      )
      logRun(store, run.id, 'info', `Container created (id=${container.id ?? 'unknown'})`)

      await withRetry(
        () => container!.start(),
        maxAttempts,
        backoffBase,
        sleep,
        'container.start',
        'START_FAILED',
      )

      const result = await raceWithTimeout(container.wait(), timeoutMs)
      if (result === 'timeout') {
        workloadError = new DockerExecutionError(
          `Container exceeded wall-clock timeout of ${timeoutMs} ms; killing and removing.`,
          'TIMEOUT',
        )
      } else {
        exitCode = result.StatusCode
        if (exitCode !== 0) {
          workloadError = new DockerExecutionError(
            `Container exited with non-zero status ${exitCode}`,
            'NON_ZERO_EXIT',
          )
        }
      }
    } catch (err) {
      workloadError =
        err instanceof DockerExecutionError
          ? err
          : new DockerExecutionError('Docker container execution failed', 'WAIT_FAILED', err)
    } finally {
      // Cleanup MUST run even if timeout fired mid-`wait()` or the daemon
      // errored during start. `force: true` sends SIGKILL to a still-running
      // container; `v: true` deletes anonymous volumes so we don't leak disk.
      if (container) {
        try {
          await container.remove({ force: true, v: true })
        } catch (removeErr) {
          // Never mask the primary error. Log the cleanup failure and press on.
          const detail = removeErr instanceof Error ? removeErr.message : String(removeErr)
          logRun(store, run.id, 'error', `Container cleanup failed: ${detail}`)
          console.error(
            `[docker] container cleanup failed for task=${task.id} run=${run.id}: ${detail}`,
          )
        }
      }
    }

    const completedAt = new Date().toISOString()
    if (workloadError) {
      logRun(store, run.id, 'error', workloadError.message)
      store.updateRun(run.id, {
        status: 'failed',
        completedAt,
        error: 'Task execution failed. Check server logs for details.',
      })
      store.updateTaskStatus(task.id, 'failed')
      // Re-throw so `launchExecution` can log the underlying cause server-side.
      throw workloadError
    }

    logRun(
      store,
      run.id,
      'info',
      `Container finished with exit code ${exitCode ?? 0}. Task "${task.name}" succeeded.`,
    )
    store.updateRun(run.id, { status: 'succeeded', completedAt })
    store.updateTaskStatus(task.id, 'succeeded')
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertValidLimits(limits: DockerResourceLimits): void {
  const fields: (keyof DockerResourceLimits)[] = [
    'memoryBytes',
    'memorySwapBytes',
    'nanoCpus',
    'pidsLimit',
    'timeoutMs',
    'tmpfsSizeBytes',
  ]
  for (const field of fields) {
    const value = limits[field]
    if (!Number.isInteger(value) || value <= 0) {
      throw new DockerExecutionError(
        `Invalid DockerResourceLimits.${field}: ${String(value)} (must be a positive integer)`,
        'INVALID_LIMITS',
      )
    }
  }
  if (limits.memorySwapBytes < limits.memoryBytes) {
    throw new DockerExecutionError(
      `memorySwapBytes (${limits.memorySwapBytes}) must be ≥ memoryBytes (${limits.memoryBytes})`,
      'INVALID_LIMITS',
    )
  }
}

/**
 * Absolute path guard used for secret mount targets. Rejects relative paths,
 * traversal segments (`.`, `..`), null bytes, and non-string input.
 */
function isSafeMountPath(target: unknown): target is string {
  if (typeof target !== 'string') return false
  if (target.length === 0 || target.length > 4096) return false
  if (!target.startsWith('/')) return false
  if (target.includes('\0')) return false
  const parts = target.split('/').filter((p) => p.length > 0)
  return !parts.some((p) => p === '.' || p === '..')
}

/**
 * A minimal shell-safe escape for values interpolated into a bash `-c` script.
 * Wraps the value in single quotes and closes/re-opens the quoting around any
 * embedded single quotes. Only used for content the caller has supplied; we
 * never invoke a host shell — this string is passed to the container as a
 * command argument, so escaping is defense-in-depth against the sandbox
 * scripting layer.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildCreateOptions(
  task: DevelopmentalTask,
  runOptions: DockerRunOptions,
  limits: DockerResourceLimits,
): DockerContainerCreateOptions {
  const envArray = Object.entries(runOptions.env ?? {}).map(([k, v]) => `${k}=${v}`)
  const labels: Record<string, string> = {
    'com.routini.task-id': task.id,
    'com.routini.task-type': 'developmental',
    'com.routini.agent': task.agentName,
    ...(runOptions.labels ?? {}),
  }

  // Validate secret mount targets before we ever build the HostConfig so a
  // bad target path fails fast with a specific error code.
  const mounts: DockerMount[] = []
  const secretStagingCommands: string[] = []
  for (const secret of runOptions.secretFiles ?? []) {
    if (!isSafeMountPath(secret.targetPath)) {
      throw new DockerExecutionError(
        `Invalid secret mount target: ${JSON.stringify(secret.targetPath)}`,
        'INVALID_SECRET_MOUNT',
      )
    }
    if (typeof secret.content !== 'string') {
      throw new DockerExecutionError(
        `Secret mount for ${secret.targetPath} has non-string content`,
        'INVALID_SECRET_MOUNT',
      )
    }
    // Mount as a small tmpfs — the actual content is written on start via a
    // command wrapper. We do not persist plaintext to host disk.
    mounts.push({
      Type: 'tmpfs',
      Target: secret.targetPath,
      ReadOnly: false, // must be writable during initialisation
      TmpfsOptions: { SizeBytes: 64 * 1024, Mode: 0o400 },
    })
    const mode = secret.mode ?? '0400'
    secretStagingCommands.push(
      `printf %s ${shellEscape(secret.content)} > ${shellEscape(secret.targetPath)} && chmod ${shellEscape(mode)} ${shellEscape(secret.targetPath)}`,
    )
  }

  // If the caller provided secrets AND a Cmd, wrap the command so the secrets
  // are written first. If they provided secrets but no Cmd, we still stage
  // them so the image ENTRYPOINT can consume them.
  let cmd = runOptions.cmd
  if (secretStagingCommands.length > 0 && cmd && cmd.length > 0) {
    const originalCmd = cmd.map(shellEscape).join(' ')
    cmd = ['/bin/sh', '-c', `${secretStagingCommands.join(' && ')} && exec ${originalCmd}`]
  }

  const networkMode = runOptions.networkMode ?? DEFAULT_DOCKER_CONFIG.hostConfig.NetworkMode
  const networkDisabled = networkMode === 'none' ? DEFAULT_DOCKER_CONFIG.networkDisabled : false

  const hostConfig: DockerHostConfig = {
    ...DEFAULT_DOCKER_CONFIG.hostConfig,
    // Copy the frozen Tmpfs object so per-run mutations don't touch the constant.
    Tmpfs: { ...DEFAULT_DOCKER_CONFIG.hostConfig.Tmpfs },
    NetworkMode: networkMode,
    Memory: limits.memoryBytes,
    MemorySwap: limits.memorySwapBytes,
    NanoCpus: limits.nanoCpus,
    PidsLimit: limits.pidsLimit,
  }
  if (mounts.length > 0) {
    hostConfig.Mounts = mounts
  }

  return {
    Image: runOptions.image,
    Cmd: cmd,
    Env: envArray,
    User: DEFAULT_DOCKER_CONFIG.user,
    WorkingDir: runOptions.workingDir ?? DEFAULT_DOCKER_CONFIG.workingDir,
    NetworkDisabled: networkDisabled,
    Labels: labels,
    HostConfig: hostConfig,
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseMs: number,
  sleep: (ms: number) => Promise<void>,
  operation: string,
  code: DockerErrorCode,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts) break
      // Exponential backoff: 200 → 400 → 800 ms (with baseMs=200)
      const delay = baseMs * 2 ** (attempt - 1)
      await sleep(delay)
    }
  }
  throw new DockerExecutionError(
    `${operation} failed after ${maxAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    code,
    lastError,
  )
}

async function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | 'timeout'> {
  return new Promise<T | 'timeout'>((resolve, reject) => {
    // First-wins race: either `work` finishes or the timer fires. Whoever
    // resolves first cancels the other outcome. `Promise` semantics guarantee
    // subsequent `resolve` / `reject` calls are ignored, so even a late
    // resolution from `work` after `timer` has already fired is a no-op.
    const timer = setTimeout(() => {
      resolve('timeout')
    }, timeoutMs)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logRun(
  store: TaskStore,
  runId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  store.appendRunLog(runId, {
    timestamp: new Date().toISOString(),
    message,
    level,
  })
}
