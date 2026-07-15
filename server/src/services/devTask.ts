/**
 * Developmental Task Service
 *
 * Runs a developmental task inside an ephemeral Docker container managed by
 * the DockerService.  The container clones the target repository, invokes
 * the selected AI agent script, commits any changes, and pushes to the
 * configured branch.
 *
 * Security controls (enforced by DockerService for every container):
 *   - Runs as unprivileged user `nobody`
 *   - `no-new-privileges` SecurityOpt prevents setuid/setgid escalation
 *   - `CapDrop ALL` removes all Linux capabilities
 *   - Memory and CPU limits prevent resource exhaustion
 *
 * SSRF mitigation: `validateRepoUrl` only accepts https:// URLs whose
 * hostname belongs to a known git-hosting service allowlist.
 */

import { randomUUID } from 'node:crypto'
import type { DevTask } from '../types.js'
import { DockerService } from './docker.js'

// ── Constants ────────────────────────────────────────────────────────────────

/** Supported AI agent identifiers. */
export const VALID_AGENTS = new Set(['opencode', 'claude', 'omnimancer'])

/**
 * Allowlist of git-hosting hostnames.
 * Subdomains of these hosts are also accepted (e.g. gist.github.com).
 */
const ALLOWED_GIT_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
]

/** Docker image used for each agent. */
const AGENT_IMAGES: Readonly<Record<string, string>> = {
  opencode: 'routini/opencode-agent:latest',
  claude:   'routini/claude-agent:latest',
  omnimancer: 'routini/omnimancer-agent:latest',
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes

// ── Types ────────────────────────────────────────────────────────────────────

export interface DevTaskResult {
  success: boolean
  /** Docker container ID (short form) used for the run. */
  containerId: string
  /** Combined stdout + stderr lines from the container. */
  logs: string[]
  /** SHA extracted from a `COMMIT_SHA=<sha>` line printed by the agent. */
  commitSha?: string
  /** Human-readable failure reason (absent on success). */
  error?: string
}

export interface RunnerOptions {
  /** Milliseconds before the container is forcefully killed.  Default: 10 min. */
  timeoutMs?: number
  /**
   * Inject a DockerService instance instead of creating a real one.
   * Used in tests to avoid requiring a live Docker daemon.
   */
  dockerService?: DockerService
}

// ── Validation ───────────────────────────────────────────────────────────────

type UrlValidResult = { valid: true; url: URL } | { valid: false; error: string }

/**
 * Validates that a repository URL is safe to pass to Docker.
 *
 * Rules enforced:
 *   1. Must be parseable as a URL.
 *   2. Must use the `https:` protocol (prevents file://, git://, ssh://, etc.).
 *   3. Hostname must match the git-host allowlist (prevents SSRF to internal services).
 *   4. Must not embed credentials (user:pass@host).
 *   5. Must not use a non-standard port.
 *   6. Must include a non-empty repository path.
 */
export function validateRepoUrl(rawUrl: string): UrlValidResult {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { valid: false, error: 'repoUrl is required' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { valid: false, error: 'repoUrl is not a valid URL' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'repoUrl must use the https:// protocol' }
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'repoUrl must not contain embedded credentials' }
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    return { valid: false, error: 'repoUrl must not specify a non-standard port' }
  }

  const isAllowedHost = ALLOWED_GIT_HOSTS.some(
    host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
  )
  if (!isAllowedHost) {
    return {
      valid: false,
      error: `repoUrl hostname is not an allowed git host. Allowed: ${ALLOWED_GIT_HOSTS.join(', ')}`,
    }
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    return { valid: false, error: 'repoUrl must include a repository path' }
  }

  return { valid: true, url: parsed }
}

/** Returns `true` if `agentId` names a supported AI coding agent. */
export function validateAgentId(agentId: string): boolean {
  return VALID_AGENTS.has(agentId)
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Executes a developmental task in an isolated Docker container.
 *
 * Flow:
 *   1. Validate `repoUrl` and `agentId` before touching Docker.
 *   2. Delegate container lifecycle to DockerService (create → start → wait → remove).
 *   3. Map the container result to a structured DevTaskResult.
 *   4. Extract a commit SHA if the agent script prints `COMMIT_SHA=<sha>`.
 *
 * The caller is responsible for updating task status in the store.
 */
export async function runDevTask(
  task: DevTask,
  options: RunnerOptions = {}
): Promise<DevTaskResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options

  // ── Input validation ─────────────────────────────────────────────
  const repoCheck = validateRepoUrl(task.repoUrl)
  if (!repoCheck.valid) {
    return { success: false, containerId: '', logs: [], error: repoCheck.error }
  }

  if (!validateAgentId(task.agentId)) {
    const supported = [...VALID_AGENTS].join(', ')
    return {
      success: false,
      containerId: '',
      logs: [],
      error: `Unsupported agent "${task.agentId}". Supported agents: ${supported}`,
    }
  }

  // ── Container setup ──────────────────────────────────────────────
  const image = AGENT_IMAGES[task.agentId]!
  // Include a random suffix so concurrent runs of the same task do not clash.
  const containerName = `routini-dev-${task.id}-${randomUUID().slice(0, 8)}`
  const service = options.dockerService ?? new DockerService()

  // ── Execution ────────────────────────────────────────────────────
  const result = await service.runContainer(
    {
      image,
      name: containerName,
      env: {
        REPO_URL: task.repoUrl,
        BRANCH:   task.branch,
        AGENT:    task.agentId,
        TASK_ID:  task.id,
      },
    },
    timeoutMs
  )

  // Infrastructure failure (image not found, daemon unreachable, etc.).
  if (result.error) {
    return {
      success: false,
      containerId: result.containerId || containerName,
      logs: result.logs,
      error: `[task:${task.id}] ${result.error}`,
    }
  }

  // Container killed due to timeout.
  if (result.timedOut) {
    return {
      success: false,
      containerId: result.containerId,
      logs: result.logs,
      error: `[task:${task.id}][container:${result.containerId}] Container timed out after ${timeoutMs}ms`,
    }
  }

  // Extract commit SHA if the agent script emitted a `COMMIT_SHA=<sha>` line.
  let commitSha: string | undefined
  for (const line of result.logs) {
    const match = /COMMIT_SHA=([0-9a-f]{7,40})\b/i.exec(line)
    if (match?.[1]) {
      commitSha = match[1]
      break
    }
  }

  if (result.exitCode === 0) {
    return {
      success: true,
      containerId: result.containerId,
      logs: result.logs,
      commitSha,
    }
  }

  return {
    success: false,
    containerId: result.containerId,
    logs: result.logs,
    error: `[task:${task.id}][container:${result.containerId}] Container exited with code ${result.exitCode ?? 'unknown'}`,
  }
}
