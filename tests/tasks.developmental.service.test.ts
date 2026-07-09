/**
 * Tests for the Developmental Task service.
 *
 * Coverage:
 *   - buildDevelopmentalRunOptions:
 *       · Correct image per agent name
 *       · Unknown agent name → INVALID_IMAGE error
 *       · All required metadata env vars are set
 *       · AI API key mounted as tmpfs secret (not env var); path in ROUTINI_AI_KEY_FILE
 *       · No AI secret mount or env var when aiApiKey is null
 *       · Git token mounted as tmpfs secret (not env var); path in ROUTINI_GIT_TOKEN_FILE
 *       · No git secret mount or env var when gitToken is null
 *       · Network mode honours the resolved value
 *       · secretFiles is undefined when no secrets are present
 *   - createDevelopmentalExecutor (integration with fake DockerClient):
 *       · Happy path: task reaches succeeded status
 *       · Non-developmental task type → WRONG_TASK_TYPE (from docker executor)
 *       · AI API key fetched per-user from AiSettingsStore at run time
 *       · Git token from factory config takes precedence
 *       · Secret mounts appear in the docker createContainer call
 *       · Network mode appears in the docker createContainer call
 *       · gitNetworkMode from config
 *       · gitToken from config
 *       · No client → MISSING_CLIENT error
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  buildDevelopmentalRunOptions,
  createDevelopmentalExecutor,
} from '../server/src/tasks/developmental/service.js'
import { DockerExecutionError } from '../server/src/tasks/docker.js'
import type {
  DockerClient,
  DockerContainer,
  DockerContainerCreateOptions,
} from '../server/src/tasks/docker.js'
import { TaskStore } from '../server/src/tasks/store.js'
import { AiSettingsStore } from '../server/src/aiSettings/store.js'
import { Encryptor, generateEncryptionKey } from '../server/src/aiSettings/encryption.js'
import type { DevelopmentalTask, DailyTask, TaskRun } from '../server/src/tasks/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-dev-service'

function makeAiSettingsStore(apiKey?: string): AiSettingsStore {
  const store = new AiSettingsStore({
    encryptor: new Encryptor(generateEncryptionKey()),
  })
  if (apiKey !== undefined) {
    store.updateSettings(USER_ID, {
      provider: 'claude-code',
      apiKey,
    })
  }
  return store
}

function makeDevTask(
  store: TaskStore,
  overrides: Partial<DevelopmentalTask> = {},
): DevelopmentalTask {
  return store.createDevelopmentalTask({
    type: 'developmental',
    userId: overrides.userId ?? USER_ID,
    name: overrides.name ?? 'Dev task',
    repoUrl: overrides.repoUrl ?? 'https://github.com/example/repo',
    agentName: overrides.agentName ?? 'claude-code',
    branchName: overrides.branchName ?? 'feature/test',
  })
}

function makeFakeContainer(exitCode = 0): DockerContainer & { removeCalls: number } {
  let removeCalls = 0
  return {
    id: 'fake-container',
    get removeCalls() { return removeCalls },
    async start() { return {} },
    async wait() { return { StatusCode: exitCode } },
    async remove() { removeCalls++; return {} },
  } as DockerContainer & { removeCalls: number }
}

function makeFakeClient(
  container?: DockerContainer,
): DockerClient & { createCalls: DockerContainerCreateOptions[] } {
  const createCalls: DockerContainerCreateOptions[] = []
  return {
    createCalls,
    async createContainer(options: DockerContainerCreateOptions) {
      createCalls.push(options)
      return container ?? makeFakeContainer()
    },
  }
}

// Minimal valid developmental task for buildDevelopmentalRunOptions tests
function makeRawDevTask(overrides: Partial<DevelopmentalTask> = {}): DevelopmentalTask {
  return {
    id: 'task-123',
    userId: USER_ID,
    name: 'Test task',
    type: 'developmental',
    repoUrl: 'https://github.com/example/repo',
    agentName: 'claude-code',
    branchName: 'feature/abc',
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — image selection
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — image selection', () => {
  it('maps opencode to the correct pinned image', () => {
    const task = makeRawDevTask({ agentName: 'opencode' })
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'routini-egress',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.image).toBe('ghcr.io/routini/agent-opencode:0.1.0')
  })

  it('maps claude-code to the correct pinned image', () => {
    const task = makeRawDevTask({ agentName: 'claude-code' })
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'routini-egress',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.image).toBe('ghcr.io/routini/agent-claude-code:0.1.0')
  })

  it('maps omnimancer to the correct pinned image', () => {
    const task = makeRawDevTask({ agentName: 'omnimancer' })
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'routini-egress',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.image).toBe('ghcr.io/routini/agent-omnimancer:0.1.0')
  })

  it('throws INVALID_IMAGE for an unknown agent name', () => {
    const task = makeRawDevTask({ agentName: 'not-a-real-agent' as never })
    expect(() =>
      buildDevelopmentalRunOptions(task, {
        gitNetworkMode: 'routini-egress',
        gitToken: null,
        aiApiKey: null,
      }),
    ).toThrow(DockerExecutionError)

    try {
      buildDevelopmentalRunOptions(task, {
        gitNetworkMode: 'routini-egress',
        gitToken: null,
        aiApiKey: null,
      })
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('INVALID_IMAGE')
      // The explicit runtime agent-name guard fires first, so the message
      // names the unknown agent and lists valid options.
      expect((err as DockerExecutionError).message).toMatch(/Unknown agent/)
      expect((err as DockerExecutionError).message).toMatch(/not-a-real-agent/)
    }
  })
})

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — metadata env vars
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — metadata env vars', () => {
  it('sets ROUTINI_TASK_ID, ROUTINI_REPO_URL, ROUTINI_BRANCH, ROUTINI_AGENT', () => {
    const task = makeRawDevTask({
      id: 'task-abc',
      repoUrl: 'https://github.com/org/project.git',
      branchName: 'fix/issue-42',
      agentName: 'opencode',
    })
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.env?.ROUTINI_TASK_ID).toBe('task-abc')
    expect(opts.env?.ROUTINI_REPO_URL).toBe('https://github.com/org/project.git')
    expect(opts.env?.ROUTINI_BRANCH).toBe('fix/issue-42')
    expect(opts.env?.ROUTINI_AGENT).toBe('opencode')
  })

  it('does NOT set ROUTINI_AI_KEY_FILE when aiApiKey is null', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.env?.ROUTINI_AI_KEY_FILE).toBeUndefined()
  })

  it('does NOT set ROUTINI_GIT_TOKEN_FILE when gitToken is null', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.env?.ROUTINI_GIT_TOKEN_FILE).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — AI API key secret mount
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — AI API key secret mount', () => {
  it('mounts the API key as a tmpfs secret at /run/secrets/ai_api_key', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: 'sk-ant-test-key',
    })
    expect(opts.secretFiles).toHaveLength(1)
    expect(opts.secretFiles?.[0].targetPath).toBe('/run/secrets/ai_api_key')
    expect(opts.secretFiles?.[0].content).toBe('sk-ant-test-key')
  })

  it('exposes the path via ROUTINI_AI_KEY_FILE, never the value itself', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: 'sk-ant-secret',
    })
    // Path is in env, value is NOT
    expect(opts.env?.ROUTINI_AI_KEY_FILE).toBe('/run/secrets/ai_api_key')
    // The plaintext key must not appear in any env var value
    for (const val of Object.values(opts.env ?? {})) {
      expect(val).not.toContain('sk-ant-secret')
    }
  })

  it('omits the secret mount and env var when no API key is provided', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.secretFiles).toBeUndefined()
    expect(opts.env?.ROUTINI_AI_KEY_FILE).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — git token secret mount
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — git token secret mount', () => {
  it('mounts the git token as a tmpfs secret at /run/secrets/git_token', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: 'ghp_testtoken123',
      aiApiKey: null,
    })
    expect(opts.secretFiles).toHaveLength(1)
    expect(opts.secretFiles?.[0].targetPath).toBe('/run/secrets/git_token')
    expect(opts.secretFiles?.[0].content).toBe('ghp_testtoken123')
  })

  it('exposes the path via ROUTINI_GIT_TOKEN_FILE, never the value itself', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: 'ghp_supersecret',
      aiApiKey: null,
    })
    expect(opts.env?.ROUTINI_GIT_TOKEN_FILE).toBe('/run/secrets/git_token')
    for (const val of Object.values(opts.env ?? {})) {
      expect(val).not.toContain('ghp_supersecret')
    }
  })

  it('omits the secret mount and env var when no git token is provided', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.secretFiles).toBeUndefined()
    expect(opts.env?.ROUTINI_GIT_TOKEN_FILE).toBeUndefined()
  })

  it('includes both secret mounts when both AI key and git token are present', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: 'ghp_abc',
      aiApiKey: 'sk-key',
    })
    expect(opts.secretFiles).toHaveLength(2)
    const paths = opts.secretFiles!.map((s) => s.targetPath)
    expect(paths).toContain('/run/secrets/ai_api_key')
    expect(paths).toContain('/run/secrets/git_token')
  })
})

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — agent runner cmd
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — agent runner cmd', () => {
  it('includes the well-known agent runner cmd so secret-staging wraps it', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.cmd).toEqual(['/usr/local/bin/routini-agent'])
  })

  it('staging commands wrap the runner cmd when secrets are present', async () => {
    // Verify via the docker executor that secrets + cmd → wrapped Cmd
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      gitToken: 'ghp_token',
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)

    // With a git token, the Cmd should be wrapped by the docker executor
    const call = client.createCalls[0]
    expect(call.Cmd?.[0]).toBe('/bin/sh')
    expect(call.Cmd?.[1]).toBe('-c')
    // The script stages the secret then exec's the runner
    expect(call.Cmd?.[2]).toContain('/run/secrets/git_token')
    expect(call.Cmd?.[2]).toContain('exec')
    expect(call.Cmd?.[2]).toContain('/usr/local/bin/routini-agent')
  })

  it('passes cmd directly (no wrapping) when no secrets are present', async () => {
    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      // no gitToken, no aiSettings
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun
    await executor(task, run, store)

    const call = client.createCalls[0]
    // No secrets → no wrapping; Cmd is the runner directly
    expect(call.Cmd).toEqual(['/usr/local/bin/routini-agent'])
  })
})

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — network mode
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — network mode', () => {
  it('uses the resolved gitNetworkMode for the network mode', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'routini-egress',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.networkMode).toBe('routini-egress')
  })

  it('uses a custom network mode when specified', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'my-custom-egress-net',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.networkMode).toBe('my-custom-egress-net')
  })

  it('accepts none as a valid network mode (no git ops)', () => {
    const task = makeRawDevTask()
    const opts = buildDevelopmentalRunOptions(task, {
      gitNetworkMode: 'none',
      gitToken: null,
      aiApiKey: null,
    })
    expect(opts.networkMode).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — happy path
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — happy path', () => {
  let store: TaskStore

  beforeEach(() => {
    store = new TaskStore()
  })

  it('transitions run and task through running → succeeded', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(store.getRun(run.id)!.status).toBe('succeeded')
    expect(store.getTask(task.id)!.status).toBe('succeeded')
  })

  it('always removes the container after a successful run', async () => {
    const container = makeFakeContainer(0)
    const client = makeFakeClient(container)
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(container.removeCalls).toBe(1)
  })

  it('selects the correct image from the agent name', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const task = makeDevTask(store, { agentName: 'omnimancer' })
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createCalls[0].Image).toBe('ghcr.io/routini/agent-omnimancer:0.1.0')
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — non-developmental task rejection
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — task type guard', () => {
  it('rejects a daily task with WRONG_TASK_TYPE', async () => {
    const store = new TaskStore()
    const daily: DailyTask = store.createDailyTask({
      type: 'daily',
      userId: USER_ID,
      name: 'Daily thing',
      subtype: 'http',
      config: { url: 'https://example.com' },
    })
    const run = store.createRun(daily.id) as TaskRun
    const executor = createDevelopmentalExecutor({
      client: makeFakeClient(),
      sleep: async () => {},
    })

    await expect(executor(daily, run, store)).rejects.toThrow(/expected "developmental"/)
    try {
      await executor(daily, run, store)
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('WRONG_TASK_TYPE')
    }
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — missing client
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — missing client', () => {
  it('throws MISSING_CLIENT when no docker client is supplied', async () => {
    const store = new TaskStore()
    const executor = createDevelopmentalExecutor({
      client: undefined as never,
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toThrow(/client is required/)
    try {
      await executor(task, run, store)
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      expect((err as DockerExecutionError).code).toBe('MISSING_CLIENT')
    }
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — AI API key secret
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — AI API key secret', () => {
  it('mounts the API key at /run/secrets/ai_api_key when user has a key', async () => {
    const aiSettings = makeAiSettingsStore('sk-ant-live-key')
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      aiSettings,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store, { userId: USER_ID })
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const mounts = client.createCalls[0].HostConfig?.Mounts ?? []
    const aiMount = mounts.find((m) => m.Target === '/run/secrets/ai_api_key')
    expect(aiMount).toBeDefined()
    expect(aiMount?.Type).toBe('tmpfs')
  })

  it('does not add an AI secret mount when the user has no key', async () => {
    // Store with no key for USER_ID
    const aiSettings = makeAiSettingsStore()
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      aiSettings,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store, { userId: USER_ID })
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const mounts = client.createCalls[0].HostConfig?.Mounts
    const aiMount = mounts?.find((m) => m.Target === '/run/secrets/ai_api_key')
    expect(aiMount).toBeUndefined()
  })

  it('does not add an AI secret mount when aiSettings is not provided', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      // no aiSettings
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const mounts = client.createCalls[0].HostConfig?.Mounts
    const aiMount = mounts?.find((m) => m.Target === '/run/secrets/ai_api_key')
    expect(aiMount).toBeUndefined()
  })

  it('fetches the AI key per-user: different users get their own key', async () => {
    // Set keys for two different users on the same shared AI settings store.
    const sharedStore = new AiSettingsStore({
      encryptor: new Encryptor(generateEncryptionKey()),
    })
    sharedStore.updateSettings('user-a', { apiKey: 'sk-user-a' })
    sharedStore.updateSettings('user-b', { apiKey: 'sk-user-b' })
    // user-c has no key
    const sharedClient = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client: sharedClient,
      aiSettings: sharedStore,
      sleep: async () => {},
    })

    const taskStore = new TaskStore()

    // --- Run as user-a (has API key) ---
    const taskA = taskStore.createDevelopmentalTask({
      type: 'developmental',
      userId: 'user-a',
      name: 'Task A',
      repoUrl: 'https://github.com/example/repo',
      agentName: 'claude-code',
    })
    const runA = taskStore.createRun(taskA.id) as TaskRun
    await executor(taskA, runA, taskStore)

    // user-a gets an AI key mount and the env var pointing to it
    const mountsA = sharedClient.createCalls[0].HostConfig?.Mounts ?? []
    expect(mountsA.some((m) => m.Target === '/run/secrets/ai_api_key')).toBe(true)
    expect(
      sharedClient.createCalls[0].Env?.some((e) => e === 'ROUTINI_AI_KEY_FILE=/run/secrets/ai_api_key'),
    ).toBe(true)
    // The plaintext key sk-user-a must not appear in any env var
    for (const kv of sharedClient.createCalls[0].Env ?? []) {
      expect(kv).not.toContain('sk-user-a')
    }

    // --- Run as user-c (no key) ---
    const clientC = makeFakeClient()
    const executorC = createDevelopmentalExecutor({
      client: clientC,
      aiSettings: sharedStore,
      sleep: async () => {},
    })
    const taskC = taskStore.createDevelopmentalTask({
      type: 'developmental',
      userId: 'user-c',
      name: 'Task C',
      repoUrl: 'https://github.com/example/repo',
      agentName: 'claude-code',
    })
    const runC = taskStore.createRun(taskC.id) as TaskRun
    await executorC(taskC, runC, taskStore)

    // user-c: no AI key mount
    const mountsC = clientC.createCalls[0].HostConfig?.Mounts
    expect(mountsC?.some((m) => m.Target === '/run/secrets/ai_api_key')).toBeFalsy()
    expect(
      clientC.createCalls[0].Env?.some((e) => e.startsWith('ROUTINI_AI_KEY_FILE=')),
    ).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — git token secret
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — git token secret', () => {
  it('mounts the git token at /run/secrets/git_token when provided via config', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      gitToken: 'ghp_real-token',
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const mounts = client.createCalls[0].HostConfig?.Mounts ?? []
    const gitMount = mounts.find((m) => m.Target === '/run/secrets/git_token')
    expect(gitMount).toBeDefined()
    expect(gitMount?.Type).toBe('tmpfs')
  })

  it('does not add a git secret mount when no token is provided', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      // no gitToken, no ROUTINI_GIT_TOKEN env (not set in tests)
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const mounts = client.createCalls[0].HostConfig?.Mounts
    const gitMount = mounts?.find((m) => m.Target === '/run/secrets/git_token')
    expect(gitMount).toBeUndefined()
  })

  it('does not expose git token value in env vars', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      gitToken: 'ghp_secret-value',
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const envVars = client.createCalls[0].Env ?? []
    for (const kv of envVars) {
      // The raw token value must not appear in any env var
      expect(kv).not.toContain('ghp_secret-value')
    }
    // But the file path MUST appear
    expect(envVars.some((e) => e === 'ROUTINI_GIT_TOKEN_FILE=/run/secrets/git_token')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — network mode
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — network mode', () => {
  it('defaults to routini-egress when gitNetworkMode is not specified', async () => {
    // Ensure DOCKER_GIT_NETWORK is not set in the test environment
    const savedEnv = process.env.DOCKER_GIT_NETWORK
    delete process.env.DOCKER_GIT_NETWORK

    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createCalls[0].HostConfig?.NetworkMode).toBe('routini-egress')

    process.env.DOCKER_GIT_NETWORK = savedEnv
  })

  it('uses gitNetworkMode from config when explicitly provided', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      gitNetworkMode: 'my-egress-net',
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createCalls[0].HostConfig?.NetworkMode).toBe('my-egress-net')
  })

  it('uses DOCKER_GIT_NETWORK env var as fallback when config is not set', async () => {
    const savedEnv = process.env.DOCKER_GIT_NETWORK
    process.env.DOCKER_GIT_NETWORK = 'env-network'

    const client = makeFakeClient()
    // Factory reads env at construction time
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createCalls[0].HostConfig?.NetworkMode).toBe('env-network')

    process.env.DOCKER_GIT_NETWORK = savedEnv
  })

  it('config gitNetworkMode takes precedence over DOCKER_GIT_NETWORK env var', async () => {
    const savedEnv = process.env.DOCKER_GIT_NETWORK
    process.env.DOCKER_GIT_NETWORK = 'env-network'

    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      gitNetworkMode: 'config-network',
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createCalls[0].HostConfig?.NetworkMode).toBe('config-network')

    process.env.DOCKER_GIT_NETWORK = savedEnv
  })

  it('emits a WARN audit log when network is not "none"', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      gitNetworkMode: 'routini-egress',
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const finalRun = store.getRun(run.id)!
    const warnLog = finalRun.logs.find((l) => l.level === 'warn')
    expect(warnLog?.message).toMatch(/network isolation relaxed/i)
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — security defaults inherited from docker executor
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — inherited security defaults', () => {
  it('runs container as non-root user 1000:1000', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(client.createCalls[0].User).toBe('1000:1000')
  })

  it('drops all Linux capabilities', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const hostConfig = client.createCalls[0].HostConfig
    expect(hostConfig?.CapDrop).toEqual(['ALL'])
    expect(hostConfig?.CapAdd).toEqual([])
    expect(hostConfig?.Privileged).toBe(false)
  })

  it('uses a read-only root filesystem with a /tmp tmpfs', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const hostConfig = client.createCalls[0].HostConfig
    expect(hostConfig?.ReadonlyRootfs).toBe(true)
    expect(hostConfig?.Tmpfs?.['/tmp']).toMatch(/noexec/)
  })

  it('labels the container with task metadata', async () => {
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    const labels = client.createCalls[0].Labels ?? {}
    expect(labels['com.routini.task-id']).toBe(task.id)
    expect(labels['com.routini.task-type']).toBe('developmental')
    expect(labels['com.routini.agent']).toBe(task.agentName)
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — failure handling
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — failure handling', () => {
  it('transitions run to failed when the container exits non-zero', async () => {
    const container = makeFakeContainer(1)
    const client = makeFakeClient(container)
    const executor = createDevelopmentalExecutor({
      client,
      sleep: async () => {},
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toThrow()

    expect(store.getRun(run.id)!.status).toBe('failed')
    expect(store.getTask(task.id)!.status).toBe('failed')
    expect(container.removeCalls).toBe(1)
  })

  it('retries createContainer on transient daemon errors', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    let attempts = 0
    const client: DockerClient & { createCalls: DockerContainerCreateOptions[] } = {
      createCalls: [],
      async createContainer(opts) {
        client.createCalls.push(opts)
        attempts++
        if (attempts < 3) throw new Error('transient')
        return makeFakeContainer()
      },
    }
    const executor = createDevelopmentalExecutor({
      client,
      createMaxAttempts: 3,
      createRetryBaseMs: 10,
      sleep,
    })
    const store = new TaskStore()
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await executor(task, run, store)

    expect(attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(store.getRun(run.id)!.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — repo URL injection guard (security)
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — repo URL injection guard', () => {
  const safeResolved = { gitNetworkMode: 'none', gitToken: null, aiApiKey: null }

  const injectionCases: Array<[string, string]> = [
    ['semicolon (command separator)', 'https://github.com/org/repo;rm -rf /'],
    ['pipe (command pipe)', 'https://github.com/org/repo|whoami'],
    ['ampersand (background job)', 'https://github.com/org/repo&cat /etc/passwd'],
    ['backtick (subshell)', 'https://github.com/org/repo`id`'],
    ['dollar-paren (subshell)', 'https://github.com/org/repo$(id)'],
    ['null byte', 'https://github.com/org/repo\x00evil'],
    ['newline injection', 'https://github.com/org/repo\nrm -rf /'],
    ['carriage return', 'https://github.com/org/repo\r'],
    ['single quote', "https://github.com/org/repo'"],
    ['double quote', 'https://github.com/org/repo"'],
    ['backslash', 'https://github.com/org/repo\\evil'],
    ['angle bracket', 'https://github.com/org/repo<evil'],
  ]

  for (const [label, repoUrl] of injectionCases) {
    it(`rejects URL with ${label}`, () => {
      const task = makeRawDevTask({ repoUrl })
      expect(() => buildDevelopmentalRunOptions(task, safeResolved)).toThrow(DockerExecutionError)
      try {
        buildDevelopmentalRunOptions(task, safeResolved)
      } catch (err) {
        expect((err as DockerExecutionError).code).toBe('INVALID_REPO_URL')
      }
    })
  }

  it('rejects a non-https scheme (git+ssh)', () => {
    const task = makeRawDevTask({ repoUrl: 'git+ssh://github.com/org/repo' })
    expect(() => buildDevelopmentalRunOptions(task, safeResolved)).toThrow(DockerExecutionError)
    try {
      buildDevelopmentalRunOptions(task, safeResolved)
    } catch (err) {
      expect((err as DockerExecutionError).code).toBe('INVALID_REPO_URL')
      expect((err as DockerExecutionError).message).toMatch(/https scheme/)
    }
  })

  it('rejects a non-https scheme (http)', () => {
    const task = makeRawDevTask({ repoUrl: 'http://github.com/org/repo' })
    expect(() => buildDevelopmentalRunOptions(task, safeResolved)).toThrow(DockerExecutionError)
    try {
      buildDevelopmentalRunOptions(task, safeResolved)
    } catch (err) {
      expect((err as DockerExecutionError).code).toBe('INVALID_REPO_URL')
    }
  })

  it('rejects a completely unparseable URL', () => {
    const task = makeRawDevTask({ repoUrl: 'not a url at all' })
    expect(() => buildDevelopmentalRunOptions(task, safeResolved)).toThrow(DockerExecutionError)
    try {
      buildDevelopmentalRunOptions(task, safeResolved)
    } catch (err) {
      expect((err as DockerExecutionError).code).toBe('INVALID_REPO_URL')
    }
  })

  it('accepts a well-formed https:// URL', () => {
    const task = makeRawDevTask({ repoUrl: 'https://github.com/org/repo.git' })
    // Should not throw
    expect(() => buildDevelopmentalRunOptions(task, safeResolved)).not.toThrow()
    const opts = buildDevelopmentalRunOptions(task, safeResolved)
    expect(opts.env?.ROUTINI_REPO_URL).toBe('https://github.com/org/repo.git')
  })
})

// ---------------------------------------------------------------------------
// buildDevelopmentalRunOptions — explicit agent name runtime check
// ---------------------------------------------------------------------------

describe('buildDevelopmentalRunOptions — explicit agent name runtime check', () => {
  it('throws INVALID_IMAGE for an agent name not in VALID_AGENTS at runtime', () => {
    // Simulate data from persistence that was stored without validation
    const task = makeRawDevTask({ agentName: 'malicious-agent' as never })
    expect(() =>
      buildDevelopmentalRunOptions(task, {
        gitNetworkMode: 'none',
        gitToken: null,
        aiApiKey: null,
      }),
    ).toThrow(DockerExecutionError)
    try {
      buildDevelopmentalRunOptions(task, {
        gitNetworkMode: 'none',
        gitToken: null,
        aiApiKey: null,
      })
    } catch (err) {
      expect((err as DockerExecutionError).code).toBe('INVALID_IMAGE')
      expect((err as DockerExecutionError).message).toMatch(/Unknown agent/)
      expect((err as DockerExecutionError).message).toMatch(/malicious-agent/)
    }
  })

  it('throws INVALID_IMAGE for an empty agent name', () => {
    const task = makeRawDevTask({ agentName: '' as never })
    expect(() =>
      buildDevelopmentalRunOptions(task, {
        gitNetworkMode: 'none',
        gitToken: null,
        aiApiKey: null,
      }),
    ).toThrow(DockerExecutionError)
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — credentials error propagation
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — credentials error propagation', () => {
  it('wraps AI settings decryption failure as CREDENTIALS_ERROR', async () => {
    // Build a fake AiSettingsStore whose getApiKeyPlaintext throws
    const brokenStore = {
      getApiKeyPlaintext: (_userId: string): string | null => {
        throw new Error('AES-GCM tag mismatch — ciphertext may have been tampered with')
      },
      hasApiKey: () => true,
      getSettings: () => ({ hasApiKey: true } as never),
      updateSettings: () => ({} as never),
      size: () => 1,
    }

    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      aiSettings: brokenStore,
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    await expect(executor(task, run, store)).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DockerExecutionError &&
        (err as DockerExecutionError).code === 'CREDENTIALS_ERROR'
      )
    })
  })

  it('includes the task id in the CREDENTIALS_ERROR message (no key values leaked)', async () => {
    const brokenStore = {
      getApiKeyPlaintext: (): string | null => {
        throw new Error('decryption failed')
      },
      hasApiKey: () => true,
      getSettings: () => ({} as never),
      updateSettings: () => ({} as never),
      size: () => 0,
    }

    const store = new TaskStore()
    const client = makeFakeClient()
    const executor = createDevelopmentalExecutor({
      client,
      aiSettings: brokenStore,
      sleep: async () => {},
    })
    const task = makeDevTask(store)
    const run = store.createRun(task.id) as TaskRun

    try {
      await executor(task, run, store)
    } catch (err) {
      expect(err).toBeInstanceOf(DockerExecutionError)
      const e = err as DockerExecutionError
      expect(e.code).toBe('CREDENTIALS_ERROR')
      // Task id must be in the message for traceability
      expect(e.message).toContain(task.id)
      // The raw cause message must NOT leak into the wrapped error message
      // (it may contain implementation details; it lives in `e.cause`).
      expect(e.message).not.toContain('decryption failed')
    }
  })
})

// ---------------------------------------------------------------------------
// createDevelopmentalExecutor — network name validation
// ---------------------------------------------------------------------------

describe('createDevelopmentalExecutor — network name validation', () => {
  const invalidNames = [
    '',
    '-starts-with-dash',
    '.starts-with-dot',
    'has spaces',
    'has;semicolon',
    'has|pipe',
    'has$dollar',
    'has`backtick`',
    'a'.repeat(256),
  ]

  for (const name of invalidNames) {
    it(`rejects invalid network name ${JSON.stringify(name)}`, () => {
      expect(() =>
        createDevelopmentalExecutor({
          client: makeFakeClient(),
          gitNetworkMode: name,
          sleep: async () => {},
        }),
      ).toThrow(DockerExecutionError)

      try {
        createDevelopmentalExecutor({
          client: makeFakeClient(),
          gitNetworkMode: name,
          sleep: async () => {},
        })
      } catch (err) {
        expect((err as DockerExecutionError).code).toBe('INVALID_CONNECTION')
      }
    })
  }

  it('accepts the "none" network name (disables networking)', () => {
    expect(() =>
      createDevelopmentalExecutor({
        client: makeFakeClient(),
        gitNetworkMode: 'none',
        sleep: async () => {},
      }),
    ).not.toThrow()
  })

  it('accepts a valid custom network name', () => {
    expect(() =>
      createDevelopmentalExecutor({
        client: makeFakeClient(),
        gitNetworkMode: 'routini-egress',
        sleep: async () => {},
      }),
    ).not.toThrow()
  })

  it('accepts network names with dots, underscores, and hyphens', () => {
    expect(() =>
      createDevelopmentalExecutor({
        client: makeFakeClient(),
        gitNetworkMode: 'my_egress.net-v2',
        sleep: async () => {},
      }),
    ).not.toThrow()
  })
})
