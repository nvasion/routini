/**
 * Tests for the Docker executor.
 *
 * We inject a fake DockerClient so tests are deterministic and never touch a
 * real daemon. Coverage includes:
 *   - Image-name validation (allowlist + rejection matrix)
 *   - Security defaults applied to every container
 *   - Retry logic with exponential backoff on transient failures
 *   - Wall-clock timeout and guaranteed cleanup in `finally`
 *   - Behavior on non-developmental tasks
 *   - Docker daemon connection resolution (fail-secure default)
 *   - Resource-limits env parsing and injection
 *   - Tmpfs `/tmp` mount under `ReadonlyRootfs`
 *   - Network-mode override with audit-log warning
 *   - Secret-file tmpfs staging with path-traversal + shell-escape defense
 *   - DockerExecutionError code taxonomy
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_DOCKER_LIMITS,
  DockerExecutionError,
  createDockerExecutor,
  defaultRunOptionsFromTask,
  readDockerLimitsFromEnv,
  resolveDockerConnection,
  validateImageName,
  validateDockerNetworkName,
} from '../server/src/tasks/docker.js'
import type {
  DockerClient,
  DockerContainer,
  DockerContainerCreateOptions,
  DockerRunOptions,
} from '../server/src/tasks/docker.js'
import { TaskStore } from '../server/src/tasks/store.js'
import type { DevelopmentalTask, DailyTask, TaskRun } from '../server/src/tasks/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-docker'

function makeDevTask(store: TaskStore, overrides: Partial<DevelopmentalTask> = {}): DevelopmentalTask {
  const task = store.createDevelopmentalTask({
    type: 'developmental',
    userId: USER_ID,
    name: overrides.name ?? 'Docker task',
    repoUrl: overrides.repoUrl ?? 'https://github.com/example/repo',
    agentName: overrides.agentName ?? 'claude-code',
    branchName: overrides.branchName ?? 'feature/x',
  })
  return task
}

interface FakeContainerOptions {
  exitCode?: number
  startShouldFail?: number // number of start() calls to fail before succeeding
  waitDelayMs?: number
  removeShouldThrow?: boolean
  waitShouldReject?: boolean
}

function makeFakeContainer(opts: FakeContainerOptions = {}): DockerContainer & {
  startCalls: number
  removeCalls: number
  waitCalls: number
} {
  let startCalls = 0
  let removeCalls = 0
  let waitCalls = 0
  const container = {
    id: 'container-abc',
    get startCalls() {
      return startCalls
    },
    get removeCalls() {
      return removeCalls
    },
    get waitCalls() {
      return waitCalls
    },
    async start() {
      startCalls++
      if (opts.startShouldFail && startCalls <= opts.startShouldFail) {
        throw new Error('daemon unavailable')
      }
      return {}
    },
    async wait() {
      waitCalls++
      if (opts.waitShouldReject) throw new Error('wait failed')
      if (opts.waitDelayMs && opts.waitDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.waitDelayMs))
      }
      return { StatusCode: opts.exitCode ?? 0 }
    },
    async remove(_options?: { force?: boolean; v?: boolean }) {
      removeCalls++
      if (opts.removeShouldThrow) throw new Error('remove failed')
      return {}
    },
  }
  return container as DockerContainer & {
    startCalls: number
    removeCalls: number
    waitCalls: number
  }
}

interface FakeClientOptions {
  container?: DockerContainer
  createShouldFail?: number
  createShouldThrow?: Error
}

function makeFakeClient(opts: FakeClientOptions = {}): DockerClient & {
  createCalls: DockerContainerCreateOptions[]
  createAttempts: number
} {
  const createCalls: DockerContainerCreateOptions[] = []
  let attempts = 0
  const client: DockerClient & {
    createCalls: DockerContainerCreateOptions[]
    createAttempts: number
  } = {
    createCalls,
    get createAttempts() {
      return attempts
    },
    async createContainer(options: DockerContainerCreateOptions) {
      attempts++
      createCalls.push(options)
      if (opts.createShouldThrow) throw opts.createShouldThrow
      if (opts.createShouldFail && attempts <= opts.createShouldFail) {
        throw new Error('transient daemon error')
      }
      return opts.container ?? makeFakeContainer()
    },
  }
  return client
}

// ---------------------------------------------------------------------------
// validateImageName
// ---------------------------------------------------------------------------

describe('validateImageName', () => {
  it.each([
    'alpine',
    'alpine:3.19',
    'library/alpine:latest',
    'ghcr.io/routini/agent:0.1.0',
    'ghcr.io/org/img:tag-with-dashes',
    'ghcr.io/routini/agent-claude-code:0.1.0',
    'registry.example.com:5000/team/image:v1.2.3',
    'nginx@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ])('accepts %s', (name) => {
    expect(validateImageName(name)).toBe(true)
  })

  it.each([
    '',
    ' alpine',
    'alpine ',
    'alpine\n',
    'alpine;rm -rf /',
    'alpine|cat /etc/passwd',
    'alpine&whoami',
    'alpine`id`',
    'alpine$USER',
    '../etc/passwd',
    'foo/../bar',
    'ALPINE:LATEST', // uppercase not allowed in path segment
    'alpine:tag with spaces',
    'alpine\ttab',
    'alpine\x00null',
    'alpine@sha256:tooShort',
    'alpine:tag@sha256:XYZ', // invalid hex
  ])('rejects %j', (name) => {
    expect(validateImageName(name)).toBe(false)
  })

  it('rejects references longer than 255 characters', () => {
    const longTag = 'a'.repeat(250)
    expect(validateImageName(`img:${longTag}`)).toBe(false)
  })

  it('rejects non-string inputs', () => {
    expect(validateImageName(undefined)).toBe(false)
    expect(validateImageName(null)).toBe(false)
    expect(validateImageName(123)).toBe(false)
    expect(validateImageName({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_DOCKER_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_DOCKER_CONFIG', () => {
  it('locks down the container to a non-root user with no capabilities', () => {
    expect(DEFAULT_DOCKER_CONFIG.user).toBe('1000:1000')
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.CapDrop).toEqual(['ALL'])
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.CapAdd).toEqual([])
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.Privileged).toBe(false)
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.ReadonlyRootfs).toBe(true)
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.SecurityOpt).toContain('no-new-privileges')
  })

  it('disables network by default', () => {
    expect(DEFAULT_DOCKER_CONFIG.networkDisabled).toBe(true)
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.NetworkMode).toBe('none')
  })

  it('caps memory, CPU, and PIDs', () => {
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.Memory).toBe(512 * 1024 * 1024)
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.MemorySwap).toBe(512 * 1024 * 1024)
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.NanoCpus).toBe(1_000_000_000)
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.PidsLimit).toBe(128)
  })

  it('leaves AutoRemove OFF so cleanup is explicit and reliable', () => {
    // We use `remove({ force: true })` in `finally` — AutoRemove would race
    // us and mask errors, so it must stay off.
    expect(DEFAULT_DOCKER_CONFIG.hostConfig.AutoRemove).toBe(false)
  })

  it('is frozen so callers cannot mutate the security defaults', () => {
    expect(Object.isFrozen(DEFAULT_DOCKER_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_DOCKER_CONFIG.hostConfig)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// defaultRunOptionsFromTask
// ---------------------------------------------------------------------------

describe('defaultRunOptionsFromTask', () => {
  it('maps each agent name to a pinned sandbox image', () => {
    const store = new TaskStore()
    for (const agentName of ['opencode', 'claude-code', 'omnimancer'] as const) {
      const task = makeDevTask(store, { agentName })
      const opts = defaultRunOptionsFromTask(task)
      expect(validateImageName(opts.image)).toBe(true)
      expect(opts.image).toContain(agentName)
    }
  })

  it('injects repo url, branch, and task id as environment variables', () => {
    const store = new TaskStore()
    const task = makeDevTask(store, {
      repoUrl: 'https://github.com/example/repo.git',
      branchName: 'feature/y',
    })
    const opts = defaultRunOptionsFromTask(task)
    expect(opts.env?.ROUTINI_TASK_ID).toBe(task.id)
    expect(opts.env?.ROUTINI_REPO_URL).toBe('https://github.com/example/repo.git')
    expect(opts.env?.ROUTINI_BRANCH).toBe('feature/y')
  })

  it('throws for an unknown agent name', () => {
    const bogus = {
      id: 'x',
      userId: USER_ID,
      name: 'x',
      type: 'developmental' as const,
      repoUrl: 'https://example.com/repo',
      agentName: 'not-a-real-agent' as never,
      branchName: 'b',
      status: 'idle' as const,
      createdAt: '',
      updatedAt: '',
    }
    expect(() => defaultRunOptionsFromTask(bogus)).toThrow(/No sandbox image/)
  })
})

// ---------------------------------------------------------------------------
// createDockerExecutor — happy path & security defaults propagation
// ---------------------------------------------------------------------------

describe('createDockerExecutor — happy path', () => {
  let store: TaskStore
  beforeEach(() => {
    store = new TaskStore()
  })

  it('applies the full security-defaults bundle to createContainer', async () => {
    const container = makeFakeContainer({ exitCode: 0 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createCalls).toHaveLength(1)
    const call = client.createCalls[0]
    expect(call.Image).toBe('ghcr.io/routini/agent-claude-code:0.1.0')
    expect(call.User).toBe('1000:1000')
    expect(call.NetworkDisabled).toBe(true)
    expect(call.HostConfig?.CapDrop).toEqual(['ALL'])
    expect(call.HostConfig?.CapAdd).toEqual([])
    expect(call.HostConfig?.Privileged).toBe(false)
    expect(call.HostConfig?.ReadonlyRootfs).toBe(true)
    expect(call.HostConfig?.NetworkMode).toBe('none')
    expect(call.HostConfig?.PidsLimit).toBe(128)
    expect(call.HostConfig?.Memory).toBe(512 * 1024 * 1024)
    expect(call.HostConfig?.MemorySwap).toBe(512 * 1024 * 1024)
    expect(call.HostConfig?.NanoCpus).toBe(1_000_000_000)
    expect(call.HostConfig?.SecurityOpt).toContain('no-new-privileges')
    expect(call.Labels).toMatchObject({
      'com.routini.task-id': task.id,
      'com.routini.task-type': 'developmental',
      'com.routini.agent': 'claude-code',
    })
  })

  it('transitions run and task through running → succeeded', async () => {
    const client = makeFakeClient({ container: makeFakeContainer({ exitCode: 0 }) })
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const finalRun = store.getRun(run.id)!
    expect(finalRun.status).toBe('succeeded')
    expect(finalRun.completedAt).toBeDefined()
    expect(finalRun.error).toBeUndefined()
    expect(store.getTask(task.id)!.status).toBe('succeeded')
  })

  it('always removes the container on successful completion', async () => {
    const container = makeFakeContainer({ exitCode: 0 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect((container as unknown as { removeCalls: number }).removeCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// createDockerExecutor — failure & retry paths
// ---------------------------------------------------------------------------

describe('createDockerExecutor — error handling', () => {
  let store: TaskStore
  beforeEach(() => {
    store = new TaskStore()
  })

  it('retries createContainer with exponential backoff on transient errors', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const client = makeFakeClient({
      createShouldFail: 2,
      container: makeFakeContainer({ exitCode: 0 }),
    })
    const executor = createDockerExecutor({
      client,
      sleep,
      createMaxAttempts: 3,
      createRetryBaseMs: 200,
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createAttempts).toBe(3)
    // Two failed attempts → two sleeps at 200 and 400 ms
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenNthCalledWith(1, 200)
    expect(sleep).toHaveBeenNthCalledWith(2, 400)
    expect(store.getRun(run.id)!.status).toBe('succeeded')
  })

  it('gives up after createMaxAttempts and fails the run', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const client = makeFakeClient({ createShouldFail: 999 })
    const executor = createDockerExecutor({
      client,
      sleep,
      createMaxAttempts: 3,
      createRetryBaseMs: 10,
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toThrow(/createContainer failed after 3 attempts/)
    expect(client.createAttempts).toBe(3)
    const finalRun = store.getRun(run.id)!
    expect(finalRun.status).toBe('failed')
    // Error surfaced to client is generic — no daemon internals leak.
    expect(finalRun.error).toBe('Task execution failed. Check server logs for details.')
    expect(store.getTask(task.id)!.status).toBe('failed')
  })

  it('rejects an invalid image name before touching the daemon', async () => {
    const client = makeFakeClient()
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      resolveRunOptions: () => ({ image: 'evil;rm -rf /' }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toThrow(/Invalid Docker image reference/)
    expect(client.createAttempts).toBe(0)
  })

  it('fails the run when the container exits non-zero', async () => {
    const container = makeFakeContainer({ exitCode: 42 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toThrow(/non-zero status 42/)
    expect(store.getRun(run.id)!.status).toBe('failed')
    // Still cleaned up.
    expect((container as unknown as { removeCalls: number }).removeCalls).toBe(1)
  })

  it('does NOT retry a non-zero exit — workload errors fail fast', async () => {
    const container = makeFakeContainer({ exitCode: 1 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({ client, sleep: async () => {}, createMaxAttempts: 3 })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toThrow()
    expect(client.createAttempts).toBe(1) // one attempt only
    expect((container as unknown as { waitCalls: number }).waitCalls).toBe(1)
  })

  it('removes the container even when workload fails', async () => {
    const container = makeFakeContainer({ exitCode: 1 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toThrow()
    expect((container as unknown as { removeCalls: number }).removeCalls).toBe(1)
  })

  it('does NOT throw over the top of the primary error when cleanup fails', async () => {
    const container = makeFakeContainer({ exitCode: 7, removeShouldThrow: true })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    // Should re-throw the workload error, NOT the remove error.
    await expect(executor(task, run, store)).rejects.toThrow(/non-zero status 7/)
    // Cleanup was attempted.
    expect((container as unknown as { removeCalls: number }).removeCalls).toBe(1)
    // Run recorded the failure.
    expect(store.getRun(run.id)!.status).toBe('failed')
    // Cleanup failure is logged.
    const errorLogs = store.getRun(run.id)!.logs.filter((l) => l.level === 'error')
    expect(errorLogs.some((l) => l.message.includes('Container cleanup failed'))).toBe(true)
  })

  it('kills and removes the container when wall-clock timeout fires', async () => {
    const container = makeFakeContainer({ waitDelayMs: 100 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      // Override the 15-minute default so this test finishes in milliseconds.
      resolveRunOptions: () => ({ image: 'alpine:3.19', timeoutMs: 20 }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(
      executor(task, run, store),
    ).rejects.toThrow(/exceeded wall-clock timeout of 20 ms/)
    expect(store.getRun(run.id)!.status).toBe('failed')
    // Cleanup guarantees removal even on timeout.
    expect((container as unknown as { removeCalls: number }).removeCalls).toBe(1)
  }, 5000)

  it('rejects non-developmental tasks so misrouting is caught early', async () => {
    const client = makeFakeClient()
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const daily: DailyTask = store.createDailyTask({
      type: 'daily',
      userId: USER_ID,
      name: 'Daily thing',
      subtype: 'http',
      config: { url: 'https://example.com' },
    })
    const run = store.createRun(daily.id) as TaskRun

    await expect(executor(daily, run, store)).rejects.toThrow(
      /expected "developmental"/,
    )
    expect(client.createAttempts).toBe(0)
  })

  it('rejects when no DockerClient is supplied', async () => {
    const executor = createDockerExecutor({ sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await expect(executor(task, run, store)).rejects.toThrow(
      /DockerExecutorConfig.client is required/,
    )
  })

  it('rejects a non-positive timeout', async () => {
    const client = makeFakeClient()
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      resolveRunOptions: (t): DockerRunOptions => ({
        image: 'alpine:3.19',
        env: { X: t.id },
        timeoutMs: 0,
      }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await expect(executor(task, run, store)).rejects.toThrow(/Invalid timeoutMs/)
  })
})

// ---------------------------------------------------------------------------
// Timeout override (fast path — fake timers avoid depending on wall clock)
// ---------------------------------------------------------------------------

describe('createDockerExecutor — timeout override', () => {
  it('honours DockerRunOptions.timeoutMs supplied by resolveRunOptions', async () => {
    const store = new TaskStore()
    const container = makeFakeContainer({ waitDelayMs: 30 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      resolveRunOptions: () => ({ image: 'alpine:3.19', timeoutMs: 5 }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await expect(executor(task, run, store)).rejects.toThrow(/timeout of 5 ms/)
  })
})

// ---------------------------------------------------------------------------
// resolveDockerConnection
// ---------------------------------------------------------------------------

describe('resolveDockerConnection', () => {
  it('refuses to default to the host Docker socket without explicit opt-in', () => {
    // Fail-secure default: a misconfigured production deployment MUST NOT
    // silently fall through to /var/run/docker.sock (root-equivalent on host).
    expect(() => resolveDockerConnection({})).toThrow(DockerExecutionError)
    try {
      resolveDockerConnection({})
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('INSECURE_CONNECTION')
    }
  })

  it('allows the default socket only when DOCKER_ALLOW_DEFAULT_SOCKET=1', () => {
    expect(
      resolveDockerConnection({ DOCKER_ALLOW_DEFAULT_SOCKET: '1' }),
    ).toEqual({ socketPath: '/var/run/docker.sock' })
  })

  it('rejects any DOCKER_ALLOW_DEFAULT_SOCKET value other than exactly "1"', () => {
    for (const value of ['true', 'yes', '0', 'TRUE', ' 1 ']) {
      expect(() => resolveDockerConnection({ DOCKER_ALLOW_DEFAULT_SOCKET: value })).toThrow(
        /No Docker daemon connection configured/,
      )
    }
  })

  it('honours DOCKER_SOCKET_PATH', () => {
    expect(resolveDockerConnection({ DOCKER_SOCKET_PATH: '/tmp/docker.sock' })).toEqual({
      socketPath: '/tmp/docker.sock',
    })
  })

  it('parses tcp:// DOCKER_HOST values', () => {
    expect(resolveDockerConnection({ DOCKER_HOST: 'tcp://docker.svc:2376' })).toEqual({
      host: 'docker.svc',
      port: 2376,
      protocol: 'http',
    })
  })

  it('upgrades to https when DOCKER_TLS_VERIFY=1', () => {
    expect(
      resolveDockerConnection({
        DOCKER_HOST: 'tcp://docker.svc:2376',
        DOCKER_TLS_VERIFY: '1',
      }),
    ).toEqual({ host: 'docker.svc', port: 2376, protocol: 'https' })
  })

  it('surfaces TLS cert paths when DOCKER_CERT_PATH is set', () => {
    expect(
      resolveDockerConnection({
        DOCKER_HOST: 'tcp://docker.svc:2376',
        DOCKER_TLS_VERIFY: '1',
        DOCKER_CERT_PATH: '/etc/docker/certs',
      }),
    ).toEqual({
      host: 'docker.svc',
      port: 2376,
      protocol: 'https',
      ca: '/etc/docker/certs/ca.pem',
      cert: '/etc/docker/certs/cert.pem',
      key: '/etc/docker/certs/key.pem',
    })
  })

  it('parses unix:// DOCKER_HOST as a socket path', () => {
    expect(resolveDockerConnection({ DOCKER_HOST: 'unix:///var/run/podman.sock' })).toEqual({
      socketPath: '/var/run/podman.sock',
    })
  })

  it('throws with context on invalid DOCKER_HOST', () => {
    expect(() => resolveDockerConnection({ DOCKER_HOST: 'not a url' })).toThrow(
      /Invalid DOCKER_HOST/,
    )
  })
})

// ---------------------------------------------------------------------------
// readDockerLimitsFromEnv
// ---------------------------------------------------------------------------

describe('readDockerLimitsFromEnv', () => {
  it('returns the default limits when the env is empty', () => {
    expect(readDockerLimitsFromEnv({})).toEqual(DEFAULT_DOCKER_LIMITS)
  })

  it('overrides individual fields from environment variables', () => {
    const limits = readDockerLimitsFromEnv({
      DOCKER_MEMORY_LIMIT: '1073741824',
      DOCKER_CPU_NANOS: '2000000000',
      DOCKER_PIDS_LIMIT: '256',
      DOCKER_TIMEOUT_MS: '60000',
      DOCKER_TMPFS_SIZE_BYTES: '134217728',
    })
    expect(limits.memoryBytes).toBe(1_073_741_824)
    // When only DOCKER_MEMORY_LIMIT is set, swap tracks it.
    expect(limits.memorySwapBytes).toBe(1_073_741_824)
    expect(limits.nanoCpus).toBe(2_000_000_000)
    expect(limits.pidsLimit).toBe(256)
    expect(limits.timeoutMs).toBe(60_000)
    expect(limits.tmpfsSizeBytes).toBe(134_217_728)
  })

  it('allows an explicit DOCKER_MEMORY_SWAP_LIMIT to override the derived value', () => {
    const limits = readDockerLimitsFromEnv({
      DOCKER_MEMORY_LIMIT: '1073741824',
      DOCKER_MEMORY_SWAP_LIMIT: '2147483648',
    })
    expect(limits.memoryBytes).toBe(1_073_741_824)
    expect(limits.memorySwapBytes).toBe(2_147_483_648)
  })

  it.each([
    ['DOCKER_MEMORY_LIMIT', '-1'],
    ['DOCKER_MEMORY_LIMIT', '0'],
    ['DOCKER_MEMORY_LIMIT', 'nope'],
    ['DOCKER_MEMORY_LIMIT', '1.5'],
    ['DOCKER_MEMORY_LIMIT', '9999999999999999999999'],
    ['DOCKER_CPU_NANOS', 'zero'],
    ['DOCKER_PIDS_LIMIT', '-10'],
    ['DOCKER_TIMEOUT_MS', ''],
  ])('rejects invalid %s=%s', (key, value) => {
    // Empty string is treated as "unset" — special-case that one, others throw.
    if (value === '') {
      expect(readDockerLimitsFromEnv({ [key]: value })).toEqual(DEFAULT_DOCKER_LIMITS)
      return
    }
    expect(() => readDockerLimitsFromEnv({ [key]: value })).toThrow(DockerExecutionError)
  })

  it('rejects invalid values with an INVALID_LIMITS error code', () => {
    try {
      readDockerLimitsFromEnv({ DOCKER_MEMORY_LIMIT: 'bogus' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('INVALID_LIMITS')
    }
  })
})

// ---------------------------------------------------------------------------
// DockerExecutionError
// ---------------------------------------------------------------------------

describe('DockerExecutionError', () => {
  it('preserves the code and cause', () => {
    const cause = new Error('root cause')
    const err = new DockerExecutionError('wrapper message', 'CREATE_FAILED', cause)
    expect(err.code).toBe('CREATE_FAILED')
    expect(err.cause).toBe(cause)
    expect(err.message).toBe('wrapper message')
    expect(err.name).toBe('DockerExecutionError')
    expect(err.stack).toContain('Caused by')
  })

  it('is thrown for non-developmental tasks with the correct code', async () => {
    const store = new TaskStore()
    const daily = store.createDailyTask({
      type: 'daily',
      userId: USER_ID,
      name: 'daily thing',
      subtype: 'http',
      config: { url: 'https://example.com' },
    })
    const run = store.createRun(daily.id) as TaskRun
    const executor = createDockerExecutor({
      client: makeFakeClient(),
      sleep: async () => {},
    })
    try {
      await executor(daily, run, store)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('WRONG_TASK_TYPE')
    }
  })

  it('is thrown with INVALID_IMAGE for bad image references', async () => {
    const store = new TaskStore()
    const executor = createDockerExecutor({
      client: makeFakeClient(),
      sleep: async () => {},
      resolveRunOptions: () => ({ image: 'evil;rm -rf /' }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    try {
      await executor(task, run, store)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('INVALID_IMAGE')
    }
  })

  it('is thrown with TIMEOUT when the wall-clock deadline fires', async () => {
    const store = new TaskStore()
    const container = makeFakeContainer({ waitDelayMs: 200 })
    const executor = createDockerExecutor({
      client: makeFakeClient({ container }),
      sleep: async () => {},
      resolveRunOptions: () => ({ image: 'alpine:3.19', timeoutMs: 10 }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    try {
      await executor(task, run, store)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('TIMEOUT')
    }
  }, 5000)

  it('is thrown with NON_ZERO_EXIT when the workload fails', async () => {
    const store = new TaskStore()
    const executor = createDockerExecutor({
      client: makeFakeClient({ container: makeFakeContainer({ exitCode: 7 }) }),
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    try {
      await executor(task, run, store)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('NON_ZERO_EXIT')
    }
  })

  it('is thrown with CREATE_FAILED after retry exhaustion', async () => {
    const store = new TaskStore()
    const executor = createDockerExecutor({
      client: makeFakeClient({ createShouldFail: 999 }),
      sleep: async () => {},
      createMaxAttempts: 2,
      createRetryBaseMs: 1,
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    try {
      await executor(task, run, store)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('CREATE_FAILED')
    }
  })
})

// ---------------------------------------------------------------------------
// Tmpfs, network mode, and secret mounts
// ---------------------------------------------------------------------------

describe('createDockerExecutor — tmpfs and read-only rootfs', () => {
  it('mounts a size-capped tmpfs at /tmp so agents have a writable scratch dir', async () => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)
    const call = client.createCalls[0]
    expect(call.HostConfig?.ReadonlyRootfs).toBe(true)
    expect(call.HostConfig?.Tmpfs).toBeDefined()
    expect(call.HostConfig?.Tmpfs?.['/tmp']).toMatch(/size=/)
    expect(call.HostConfig?.Tmpfs?.['/tmp']).toContain('noexec')
    expect(call.HostConfig?.Tmpfs?.['/tmp']).toContain('nosuid')
  })
})

describe('createDockerExecutor — network mode override', () => {
  it('keeps NetworkMode="none" and NetworkDisabled=true by default', async () => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDockerExecutor({ client, sleep: async () => {} })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)
    const call = client.createCalls[0]
    expect(call.HostConfig?.NetworkMode).toBe('none')
    expect(call.NetworkDisabled).toBe(true)
    // No warning log in the run.
    const finalRun = store.getRun(run.id)!
    expect(finalRun.logs.some((l) => l.level === 'warn')).toBe(false)
  })

  it('allows a named egress network for git operations and logs a WARN audit entry', async () => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      resolveRunOptions: (t) => ({
        image: 'ghcr.io/routini/agent-claude-code:0.1.0',
        networkMode: 'routini-egress',
        env: { ROUTINI_TASK_ID: t.id },
      }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)
    const call = client.createCalls[0]
    expect(call.HostConfig?.NetworkMode).toBe('routini-egress')
    expect(call.NetworkDisabled).toBe(false)
    const finalRun = store.getRun(run.id)!
    const warnLog = finalRun.logs.find((l) => l.level === 'warn')
    expect(warnLog?.message).toMatch(/network isolation relaxed/i)
    expect(warnLog?.message).toContain('routini-egress')
  })
})

describe('createDockerExecutor — secret mounts', () => {
  it('registers a tmpfs mount for each secret file and wraps Cmd to stage them', async () => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      resolveRunOptions: () => ({
        image: 'ghcr.io/routini/agent-claude-code:0.1.0',
        cmd: ['node', 'run.js'],
        secretFiles: [
          { targetPath: '/run/secrets/git_token', content: 'ghp_abc123' },
          { targetPath: '/run/secrets/ssh_key', content: '-----BEGIN KEY-----', mode: '0400' },
        ],
      }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)
    const call = client.createCalls[0]
    // Secrets appear as tmpfs mounts, never bind-mounted from host disk.
    expect(call.HostConfig?.Mounts).toHaveLength(2)
    expect(call.HostConfig?.Mounts?.[0]).toMatchObject({
      Type: 'tmpfs',
      Target: '/run/secrets/git_token',
    })
    expect(call.HostConfig?.Mounts?.[1]).toMatchObject({
      Type: 'tmpfs',
      Target: '/run/secrets/ssh_key',
    })
    // Cmd is wrapped to write secrets before exec'ing the original command.
    expect(call.Cmd?.[0]).toBe('/bin/sh')
    expect(call.Cmd?.[1]).toBe('-c')
    expect(call.Cmd?.[2]).toContain('/run/secrets/git_token')
    expect(call.Cmd?.[2]).toContain('/run/secrets/ssh_key')
    expect(call.Cmd?.[2]).toContain('exec')
  })

  it.each([
    'relative/path',
    '',
    '/etc/../passwd',
    '/absolute/./ok', // dot segment rejected
    '/with\0null',
  ])('rejects unsafe secret target path %j', async (targetPath) => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      resolveRunOptions: () => ({
        image: 'alpine:3.19',
        secretFiles: [{ targetPath: targetPath as string, content: 'x' }],
      }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    try {
      await executor(task, run, store)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('INVALID_SECRET_MOUNT')
    }
    // Never touched the daemon.
    expect(client.createCalls).toHaveLength(0)
  })

  it('escapes single quotes in secret content so shell injection is impossible', async () => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      resolveRunOptions: () => ({
        image: 'alpine:3.19',
        cmd: ['run'],
        secretFiles: [
          { targetPath: '/run/secrets/tok', content: "'; rm -rf / #" },
        ],
      }),
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)
    const script = client.createCalls[0].Cmd?.[2] ?? ''
    // The dangerous chars appear only inside a quoted literal, never as active shell.
    expect(script).not.toMatch(/^\s*'; rm -rf/)
    expect(script).toContain(`'\\''; rm -rf / #`)
  })
})

// ---------------------------------------------------------------------------
// Resource limits injection
// ---------------------------------------------------------------------------

describe('createDockerExecutor — resource limits', () => {
  it('propagates injected limits into the HostConfig', async () => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      limits: {
        memoryBytes: 2 * 1024 * 1024 * 1024,
        memorySwapBytes: 4 * 1024 * 1024 * 1024,
        nanoCpus: 4_000_000_000,
        pidsLimit: 512,
        timeoutMs: 60_000,
        tmpfsSizeBytes: 128 * 1024 * 1024,
      },
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)
    const call = client.createCalls[0]
    expect(call.HostConfig?.Memory).toBe(2 * 1024 * 1024 * 1024)
    expect(call.HostConfig?.MemorySwap).toBe(4 * 1024 * 1024 * 1024)
    expect(call.HostConfig?.NanoCpus).toBe(4_000_000_000)
    expect(call.HostConfig?.PidsLimit).toBe(512)
  })

  it('uses the injected limits.timeoutMs as the wall-clock default', async () => {
    const store = new TaskStore()
    const container = makeFakeContainer({ waitDelayMs: 200 })
    const client = makeFakeClient({ container })
    const executor = createDockerExecutor({
      client,
      sleep: async () => {},
      limits: { ...DEFAULT_DOCKER_LIMITS, timeoutMs: 15 },
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await expect(executor(task, run, store)).rejects.toThrow(/timeout of 15 ms/)
  }, 5000)

  it.each([
    { memoryBytes: 0 },
    { memoryBytes: -1 },
    { pidsLimit: 1.5 },
    { timeoutMs: Number.NaN },
    { nanoCpus: 0 },
  ])('rejects invalid limits at factory time: %o', (patch) => {
    const limits = { ...DEFAULT_DOCKER_LIMITS, ...patch }
    expect(() => createDockerExecutor({ limits })).toThrow(DockerExecutionError)
  })

  it('rejects swap smaller than memory', () => {
    expect(() =>
      createDockerExecutor({
        limits: {
          ...DEFAULT_DOCKER_LIMITS,
          memoryBytes: 2 * 1024 * 1024 * 1024,
          memorySwapBytes: 1 * 1024 * 1024 * 1024,
        },
      }),
    ).toThrow(/memorySwapBytes/)
  })
})

// ---------------------------------------------------------------------------
// validateDockerNetworkName
// ---------------------------------------------------------------------------

describe('validateDockerNetworkName', () => {
  // Valid names
  const validNames = [
    'none',
    'bridge',
    'routini-egress',
    'my_network',
    'net.v2',
    'abc123',
    'A',
    '0',
    'my_egress.net-v2',
    'a'.repeat(255),
  ]
  for (const name of validNames) {
    it(`accepts valid name: ${JSON.stringify(name)}`, () => {
      expect(validateDockerNetworkName(name)).toBe(true)
    })
  }

  // Invalid names
  const invalidNames: Array<[string, unknown]> = [
    ['empty string', ''],
    ['starts with dash', '-net'],
    ['starts with dot', '.net'],
    ['contains space', 'my network'],
    ['contains semicolon', 'net;evil'],
    ['contains pipe', 'net|evil'],
    ['contains dollar', 'net$evil'],
    ['contains backtick', 'net`cmd`'],
    ['contains null byte', 'net\x00evil'],
    ['contains newline', 'net\nevil'],
    ['contains tab', 'net\tevil'],
    ['too long (256 chars)', 'a'.repeat(256)],
    ['non-string (number)', 42],
    ['non-string (null)', null],
    ['non-string (undefined)', undefined],
    ['non-string (object)', {}],
  ]
  for (const [label, name] of invalidNames) {
    it(`rejects invalid name: ${label}`, () => {
      expect(validateDockerNetworkName(name)).toBe(false)
    })
  }
})
