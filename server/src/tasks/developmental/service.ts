/**
 * Developmental Task executor.
 *
 * Bridges the generic Docker executor (`docker.ts`) and the concrete
 * requirements of developmental tasks: repo cloning, AI-agent execution,
 * git commit, and push.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Map each supported AI agent name to its pinned sandbox Docker image.
 *  2. Enable git-capable network access by overriding the default "none"
 *     `NetworkMode` with a configurable egress-filtered bridge network.
 *  3. Retrieve the user's AI-provider API key from the `AiSettingsStore` and
 *     mount it as a tmpfs-backed secret inside the container.
 *  4. Mount git HTTPS credentials as a tmpfs-backed secret.
 *  5. Expose non-sensitive metadata (repo URL, branch, task ID, agent name)
 *     and secret file paths as environment variables for the agent script.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Security posture
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Credentials (AI API keys, git tokens) are NEVER passed as environment
 *    variables. They live in tmpfs-backed mounts so they do not appear in
 *    `docker inspect` output or crash dumps. The agent discovers file paths
 *    via ROUTINI_AI_KEY_FILE / ROUTINI_GIT_TOKEN_FILE environment variables
 *    rather than receiving the values directly.
 *  - Network is widened from "none" only to the git-capable network. Production
 *    deployments SHOULD configure DOCKER_GIT_NETWORK to point at an
 *    egress-filtered bridge network that allows only 22/tcp and 443/tcp
 *    outbound (git+ssh and git+https). The executor logs a WARN for the
 *    audit trail any time the non-"none" network is activated (inherited from
 *    the underlying `createDockerExecutor` implementation).
 *  - git tokens and AI keys are read from the store / env at factory
 *    construction time (for the git token) or at run time (for the per-user
 *    AI key), never stored on the closure beyond the run boundary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   import Docker from 'dockerode'
 *   import { resolveDockerConnection, createDevelopmentalExecutor } from '...'
 *
 *   const dockerClient = new Docker(resolveDockerConnection(process.env))
 *   const devExecutor = createDevelopmentalExecutor({
 *     client: dockerClient,
 *     aiSettings,           // AiSettingsStore for per-user API key retrieval
 *     limits: readDockerLimitsFromEnv(process.env),
 *   })
 *   launchExecution(task, run, store, devExecutor)
 */

import type { TaskExecutor } from '../executor.js'
import type { AiSettingsStore } from '../../aiSettings/store.js'
import type { AgentName, DevelopmentalTask } from '../types.js'
import {
  createDockerExecutor,
  DockerExecutionError,
  validateImageName,
  validateDockerNetworkName,
} from '../docker.js'
import type {
  DockerClient,
  DockerResourceLimits,
  DockerRunOptions,
  SecretMount,
} from '../docker.js'
import { VALID_AGENTS } from '../validation.js'

// ---------------------------------------------------------------------------
// Agent image registry
// ---------------------------------------------------------------------------

/**
 * Maps each supported agent name to its pinned sandbox image. All images share
 * the same contract: read `ROUTINI_REPO_URL`, `ROUTINI_BRANCH`, and optional
 * credential files, run the agent, commit changes, and push. Update a tag here
 * when a new agent version is certified and tested.
 *
 * The type `Record<AgentName, string>` enforces at compile time that every
 * AgentName has a corresponding image. The runtime check in
 * `buildDevelopmentalRunOptions` provides defense-in-depth for data that
 * arrives from the database without going through the TypeScript type checker.
 */
const AGENT_IMAGES: Record<AgentName, string> = {
  opencode: 'ghcr.io/routini/agent-opencode:0.1.0',
  'claude-code': 'ghcr.io/routini/agent-claude-code:0.1.0',
  omnimancer: 'ghcr.io/routini/agent-omnimancer:0.1.0',
}

// ---------------------------------------------------------------------------
// URL safety guard
// ---------------------------------------------------------------------------

/**
 * Characters that must not appear in a git repository URL used as a container
 * environment variable. If the agent script later interpolates
 * `$ROUTINI_REPO_URL` into a shell command (e.g. `git clone "$ROUTINI_REPO_URL"`)
 * these characters could terminate or redirect the command.
 *
 * Rejected: null byte, CR/LF, semicolons, pipes, ampersands, backtick,
 * dollar-sign (including `$(…)` substitution), angle brackets, single/double
 * quotes, and backslashes. The URL scheme, host, path, and query components
 * do not require any of these, so rejecting them is safe.
 */
const UNSAFE_URL_CHARS = /[;\|&`$\x00\r\n<>'"\\]/

/**
 * Validate a git repository URL before it is passed into a container as
 * an environment variable.
 *
 * Rules (defense-in-depth on top of the validation applied at task-creation
 * time by `validateUrl` in validation.ts):
 *   1. Must be parseable as a URL.
 *   2. Must use the `https:` scheme — git+https is the only auth mode we
 *      support (via the personal-access-token secret mount).
 *   3. Must not contain shell metacharacters that could enable injection if
 *      the agent script interpolates the value into a shell command.
 *
 * Throws `DockerExecutionError('INVALID_REPO_URL')` on violation.
 */
function assertSafeRepoUrl(url: string): void {
  if (UNSAFE_URL_CHARS.test(url)) {
    throw new DockerExecutionError(
      'repoUrl contains characters that could enable shell injection (;|&`$\\r\\n<>\'"\\\\)',
      'INVALID_REPO_URL',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DockerExecutionError(
      'repoUrl is not a valid URL',
      'INVALID_REPO_URL',
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new DockerExecutionError(
      `repoUrl must use the https scheme for git operations (got "${parsed.protocol.replace(/:$/, '')}")`,
      'INVALID_REPO_URL',
    )
  }
}

/** Default Docker network that permits outbound git traffic. */
const DEFAULT_GIT_NETWORK = 'routini-egress'

/**
 * Well-known agent runner script path inside every routini agent image.
 *
 * All agent images implement the routini agent contract and expose this
 * entry point. The docker executor uses it to wrap secret-staging commands
 * before exec'ing the agent, ensuring credentials are written to tmpfs mounts
 * before the agent process starts. Without an explicit cmd, the staging
 * script produced by `buildCreateOptions` in docker.ts would not run and the
 * secret files would remain empty when the agent reads them.
 */
const AGENT_RUNNER_CMD = '/usr/local/bin/routini-agent'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DevelopmentalExecutorConfig {
  /**
   * Docker client — required. In production, wire a real `dockerode` instance
   * built from `resolveDockerConnection(process.env)`. Tests inject a fake.
   */
  client: DockerClient
  /**
   * AI settings store used to fetch the per-user AI-provider API key at run
   * time. When present and the user has configured a key, it is mounted at
   * `/run/secrets/ai_api_key` and its path exposed via `ROUTINI_AI_KEY_FILE`.
   * When absent or the user has no key, the secret mount is skipped and no
   * env var is set — the agent must gracefully handle a missing credential.
   */
  aiSettings?: AiSettingsStore
  /**
   * Docker network that allows outbound git traffic (clone / push).
   * Falls back to `process.env.DOCKER_GIT_NETWORK` then `'routini-egress'`.
   *
   * Production SHOULD configure this to an egress-filtered bridge that only
   * allows 22/tcp and 443/tcp outbound. Set it to the default 'none' in unit
   * tests where no actual git operations occur.
   */
  gitNetworkMode?: string
  /**
   * HTTPS git credential (personal access token or OAuth token).
   * Falls back to `process.env.ROUTINI_GIT_TOKEN`.
   *
   * When present, mounted at `/run/secrets/git_token` and the path exposed
   * via `ROUTINI_GIT_TOKEN_FILE`. Without a token, the agent can only clone
   * public repos. SSH-based auth is not currently supported; use HTTPS tokens.
   *
   * SECURITY: The value is never set as an environment variable on the
   * container — it is always mounted as a tmpfs-backed file.
   */
  gitToken?: string
  /** Resource limits override forwarded to the underlying Docker executor. */
  limits?: DockerResourceLimits
  /** Max container-creation attempts (default 3). */
  createMaxAttempts?: number
  /** Base backoff in ms for container-creation retries (default 200). */
  createRetryBaseMs?: number
  /**
   * Sleep implementation. Override in tests to avoid real-time waits during
   * retry backoff.
   */
  sleep?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Option builder (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build the per-run `DockerRunOptions` for a developmental task.
 *
 * Exported as a named function (rather than inlined in the factory closure)
 * so unit tests can exercise option-building in isolation — verifying image
 * selection, secret mount paths, env vars, and network mode — without spinning
 * up a real Docker executor or fake container.
 *
 * @param task    - The developmental task being executed.
 * @param resolved - Pre-resolved config values (no env reads happen here).
 */
export function buildDevelopmentalRunOptions(
  task: DevelopmentalTask,
  resolved: {
    /** Docker network for git operations (already resolved from config/env). */
    gitNetworkMode: string
    /** Plaintext git HTTPS token, or null if not available. */
    gitToken: string | null
    /** Plaintext AI provider API key for the task's owner, or null if not set. */
    aiApiKey: string | null
  },
): DockerRunOptions {
  // ── Runtime agent name validation (defense-in-depth) ────────────────────
  // VALID_AGENTS is the single source of truth from validation.ts. Even
  // though the TypeScript type `AgentName` is a discriminated union, data
  // read from the store may have been created before a validation rule existed
  // or may have been tampered with in a persistence layer.
  const validAgentSet = new Set<string>(VALID_AGENTS)
  if (!validAgentSet.has(task.agentName)) {
    throw new DockerExecutionError(
      `Unknown agent "${task.agentName}"; valid values: ${VALID_AGENTS.join(', ')}`,
      'INVALID_IMAGE',
    )
  }

  const image = AGENT_IMAGES[task.agentName]
  if (!image || !validateImageName(image)) {
    throw new DockerExecutionError(
      `No sandbox image registered for agent "${task.agentName}"`,
      'INVALID_IMAGE',
    )
  }

  // ── Repo URL safety guard ────────────────────────────────────────────────
  // Re-validate here even though the URL was validated at task-creation time.
  // Defense-in-depth: if the value was stored before the validation existed
  // or the DB layer is bypassed, this prevents shell injection inside the
  // container when the agent interpolates ROUTINI_REPO_URL into `git clone`.
  assertSafeRepoUrl(task.repoUrl)

  const secretFiles: SecretMount[] = []
  const env: Record<string, string> = {
    // Non-sensitive metadata exposed as plain env vars.
    ROUTINI_TASK_ID: task.id,
    ROUTINI_REPO_URL: task.repoUrl,
    ROUTINI_BRANCH: task.branchName,
    ROUTINI_AGENT: task.agentName,
  }

  // AI provider API key — mount as tmpfs secret; expose only the path via env.
  if (resolved.aiApiKey !== null) {
    secretFiles.push({
      targetPath: '/run/secrets/ai_api_key',
      content: resolved.aiApiKey,
    })
    env.ROUTINI_AI_KEY_FILE = '/run/secrets/ai_api_key'
  }

  // Git HTTPS token — mount as tmpfs secret; expose only the path via env.
  if (resolved.gitToken !== null) {
    secretFiles.push({
      targetPath: '/run/secrets/git_token',
      content: resolved.gitToken,
    })
    env.ROUTINI_GIT_TOKEN_FILE = '/run/secrets/git_token'
  }

  return {
    image,
    // Provide the agent runner cmd so the docker executor can prepend
    // secret-staging shell commands before exec'ing the runner. Without an
    // explicit cmd the tmpfs secret mounts would be created but their content
    // would never be written, leaving the files empty when the agent reads them.
    cmd: [AGENT_RUNNER_CMD],
    networkMode: resolved.gitNetworkMode,
    env,
    ...(secretFiles.length > 0 && { secretFiles }),
  }
}

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * Build a `TaskExecutor` for developmental tasks.
 *
 * Reads git network mode and git token from the config (falling back to
 * environment variables) at factory-construction time so the executor's
 * behaviour is deterministic after startup. The per-user AI API key is fetched
 * from the `aiSettings` store at run time (inside `resolveRunOptions`) because
 * it is user-scoped and the store may be updated between runs.
 *
 * The factory delegates container lifecycle management entirely to
 * `createDockerExecutor` — all security defaults (non-root user, read-only
 * rootfs, capability drops, PID/memory limits, guaranteed container removal)
 * are inherited without modification.
 */
export function createDevelopmentalExecutor(
  config: DevelopmentalExecutorConfig,
): TaskExecutor {
  // Resolve env-backed values once at factory time — consistent with how
  // `readDockerLimitsFromEnv` and `resolveDockerConnection` work.
  const gitNetworkMode =
    config.gitNetworkMode ??
    process.env.DOCKER_GIT_NETWORK ??
    DEFAULT_GIT_NETWORK

  // ── Network name validation ────────────────────────────────────────────────
  // Validate at factory construction time so a misconfigured DOCKER_GIT_NETWORK
  // causes an immediate, loud failure rather than a silent per-task failure.
  // Docker network names must start with an alphanumeric character and contain
  // only alphanumeric characters, underscores, hyphens, or dots.
  if (!validateDockerNetworkName(gitNetworkMode)) {
    throw new DockerExecutionError(
      `Invalid Docker network name "${gitNetworkMode}" (from DOCKER_GIT_NETWORK or gitNetworkMode config). ` +
        'Network names must start with an alphanumeric character and contain only ' +
        'alphanumeric characters, underscores, hyphens, or dots.',
      'INVALID_CONNECTION',
    )
  }

  const gitToken: string | null =
    config.gitToken ?? process.env.ROUTINI_GIT_TOKEN ?? null

  return createDockerExecutor({
    client: config.client,
    limits: config.limits,
    createMaxAttempts: config.createMaxAttempts,
    createRetryBaseMs: config.createRetryBaseMs,
    sleep: config.sleep,
    /**
     * Per-run option builder. Captures the resolved network/token from the
     * factory closure and fetches the per-user AI key from the store on each
     * invocation so key updates take effect immediately.
     *
     * AI key retrieval is wrapped in a try/catch: an `EncryptionError` from
     * `getApiKeyPlaintext` (e.g. key-ring rotation mismatch or tampered
     * ciphertext) is surfaced as a typed `CREDENTIALS_ERROR` so the task run
     * log contains a clear, sanitised explanation rather than a raw crypto
     * error that might leak implementation details.
     */
    resolveRunOptions: (task: DevelopmentalTask): DockerRunOptions => {
      let aiApiKey: string | null = null
      if (config.aiSettings) {
        try {
          aiApiKey = config.aiSettings.getApiKeyPlaintext(task.userId)
        } catch (err) {
          throw new DockerExecutionError(
            `Failed to retrieve AI credentials for task "${task.id}": decryption failed`,
            'CREDENTIALS_ERROR',
            err,
          )
        }
      }
      return buildDevelopmentalRunOptions(task, { gitNetworkMode, gitToken, aiApiKey })
    },
  })
}
