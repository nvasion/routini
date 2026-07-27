/**
 * Tests for integration credential scoping and container-env injection
 * (server/src/services/integrations.ts), plus an end-to-end "fake spawn"
 * test proving that `runDevTask` only forwards in-scope, connected
 * integration credentials to the container and withholds everything else.
 *
 * Coverage:
 *   – catalog shape (all seven v1 integrations, correct env var names)
 *   – default scope (allow all task types / agents) when never configured
 *   – setIntegrationScope validation (bad task type, bad agent, empty arrays)
 *   – getScopedIntegrationEnv: connected + in-scope → included
 *   – getScopedIntegrationEnv: not connected → withheld
 *   – getScopedIntegrationEnv: connected but wrong task type → withheld
 *   – getScopedIntegrationEnv: connected but wrong agent → withheld
 *   – corrupt/tampered stored scope → fails closed (denies, does not default-allow)
 *   – fake-spawn: runDevTask forwards only in-scope tokens as container env vars
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { vi } from 'vitest'
import {
  INTEGRATIONS,
  isIntegrationId,
  getIntegrationScope,
  setIntegrationScope,
  setIntegrationToken,
  isIntegrationConnected,
  getScopedIntegrationEnv,
  validateScope,
  ALL_TASK_TYPES,
  ALL_AGENT_IDS,
} from '../server/src/services/integrations.js'
import { saveCredential } from '../server/src/services/credentials.js'
import { getDb, closeDb, resetDb } from '../server/src/db/index.js'
import { runDevTask } from '../server/src/services/devTask.js'
import type { DockerService, ContainerConfig, ContainerLifecycleResult } from '../server/src/services/docker.js'
import type { DevTask } from '../server/src/types.js'

const originalNodeEnv = process.env['NODE_ENV']

beforeEach(() => {
  process.env['NODE_ENV'] = 'test'
  resetDb()
})

afterAll(() => {
  closeDb()
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = originalNodeEnv
})

// ═════════════════════════════════════════════════════════════════════════════
// Catalog
// ═════════════════════════════════════════════════════════════════════════════

describe('INTEGRATIONS catalog', () => {
  it('defines exactly the seven v1 integrations', () => {
    expect(Object.keys(INTEGRATIONS).sort()).toEqual(
      ['github', 'hubspot', 'jira', 'linear', 'monday', 'notion', 'slack'].sort(),
    )
  })

  it('maps each integration to its documented env var name', () => {
    expect(INTEGRATIONS.github.envVar).toBe('GITHUB_TOKEN')
    expect(INTEGRATIONS.slack.envVar).toBe('SLACK_BOT_TOKEN')
    expect(INTEGRATIONS.jira.envVar).toBe('JIRA_API_TOKEN')
    expect(INTEGRATIONS.notion.envVar).toBe('NOTION_TOKEN')
    expect(INTEGRATIONS.linear.envVar).toBe('LINEAR_API_KEY')
    expect(INTEGRATIONS.monday.envVar).toBe('MONDAY_TOKEN')
    expect(INTEGRATIONS.hubspot.envVar).toBe('HUBSPOT_TOKEN')
  })

  it('isIntegrationId accepts catalog ids and rejects unknown values', () => {
    expect(isIntegrationId('github')).toBe(true)
    expect(isIntegrationId('not-a-real-integration')).toBe(false)
    expect(isIntegrationId(42)).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// getIntegrationScope / setIntegrationScope
// ═════════════════════════════════════════════════════════════════════════════

describe('getIntegrationScope', () => {
  it('defaults to allowing every task type and agent when never configured', () => {
    const scope = getIntegrationScope('github')
    expect(scope.taskTypes.sort()).toEqual([...ALL_TASK_TYPES].sort())
    expect(scope.agents.sort()).toEqual([...ALL_AGENT_IDS].sort())
  })

  it('round-trips a scope set via setIntegrationScope', () => {
    setIntegrationScope('slack', { taskTypes: ['developmental'], agents: ['claude'] })
    expect(getIntegrationScope('slack')).toEqual({
      taskTypes: ['developmental'],
      agents: ['claude'],
    })
  })

  it('fails closed (denies everything) when stored scope data is corrupt', () => {
    // Simulate tampering / corruption by writing non-JSON directly under the
    // same credential key setIntegrationScope would use.
    saveCredential(null, 'integration_jira_scope', 'not valid json{{{')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scope = getIntegrationScope('jira')
    expect(scope).toEqual({ taskTypes: [], agents: [] })
    errSpy.mockRestore()
  })

  it('fails closed when stored scope JSON has the wrong shape', () => {
    saveCredential(null, 'integration_notion_scope', JSON.stringify({ foo: 'bar' }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(getIntegrationScope('notion')).toEqual({ taskTypes: [], agents: [] })
    errSpy.mockRestore()
  })
})

describe('validateScope / setIntegrationScope validation', () => {
  it('rejects an unknown task type', () => {
    expect(() =>
      setIntegrationScope('github', { taskTypes: ['nonsense' as never], agents: ['claude'] }),
    ).toThrow(/invalid task type/)
  })

  it('rejects an unknown agent id', () => {
    expect(() =>
      setIntegrationScope('github', { taskTypes: ['developmental'], agents: ['super-agent'] }),
    ).toThrow(/invalid agent id/)
  })

  it('rejects an empty taskTypes array', () => {
    expect(() => validateScope({ taskTypes: [], agents: ['claude'] })).toThrow(/non-empty array/)
  })

  it('rejects an empty agents array', () => {
    expect(() => validateScope({ taskTypes: ['developmental'], agents: [] })).toThrow(
      /non-empty array/,
    )
  })

  it('de-duplicates repeated entries', () => {
    const result = validateScope({
      taskTypes: ['developmental', 'developmental'],
      agents: ['claude', 'claude', 'opencode'],
    })
    expect(result.taskTypes).toEqual(['developmental'])
    expect(result.agents).toEqual(['claude', 'opencode'])
  })

  it('rejects setting scope on an unknown integration id', () => {
    expect(() =>
      setIntegrationScope('not-real' as never, { taskTypes: ['developmental'], agents: ['claude'] }),
    ).toThrow(/Unknown integration id/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// isIntegrationConnected / setIntegrationToken
// ═════════════════════════════════════════════════════════════════════════════

describe('isIntegrationConnected / setIntegrationToken', () => {
  it('reports false before a token is stored and true after', () => {
    expect(isIntegrationConnected('linear')).toBe(false)
    setIntegrationToken('linear', 'lin_api_key_123')
    expect(isIntegrationConnected('linear')).toBe(true)
  })

  it('rejects storing a token for an unknown integration id', () => {
    expect(() => setIntegrationToken('not-real' as never, 'x')).toThrow(/Unknown integration id/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// getScopedIntegrationEnv
// ═════════════════════════════════════════════════════════════════════════════

describe('getScopedIntegrationEnv', () => {
  it('returns an empty object when no integrations are connected', () => {
    expect(getScopedIntegrationEnv('developmental', 'claude')).toEqual({})
  })

  it('includes a connected integration that is in scope by default (allow-all)', () => {
    setIntegrationToken('github', 'ghp_abc123')
    const env = getScopedIntegrationEnv('developmental', 'claude')
    expect(env['GITHUB_TOKEN']).toBe('ghp_abc123')
  })

  it('withholds a token for an integration that has never been connected, even if in scope', () => {
    setIntegrationScope('hubspot', { taskTypes: ['developmental'], agents: ['claude'] })
    const env = getScopedIntegrationEnv('developmental', 'claude')
    expect(env['HUBSPOT_TOKEN']).toBeUndefined()
  })

  it('withholds a connected token when the task type is out of scope', () => {
    setIntegrationToken('jira', 'jira-token-xyz')
    setIntegrationScope('jira', { taskTypes: ['daily'], agents: ['claude'] })
    const env = getScopedIntegrationEnv('developmental', 'claude')
    expect(env['JIRA_API_TOKEN']).toBeUndefined()
  })

  it('withholds a connected token when the agent is out of scope', () => {
    setIntegrationToken('slack', 'xoxb-slack-token')
    setIntegrationScope('slack', { taskTypes: ['developmental'], agents: ['opencode'] })
    const env = getScopedIntegrationEnv('developmental', 'claude')
    expect(env['SLACK_BOT_TOKEN']).toBeUndefined()
  })

  it('includes a connected token once scoped back to the requesting task type and agent', () => {
    setIntegrationToken('slack', 'xoxb-slack-token')
    setIntegrationScope('slack', { taskTypes: ['developmental'], agents: ['claude', 'opencode'] })
    const env = getScopedIntegrationEnv('developmental', 'claude')
    expect(env['SLACK_BOT_TOKEN']).toBe('xoxb-slack-token')
  })

  it('never includes a integration whose scope failed closed due to corrupt data', () => {
    setIntegrationToken('monday', 'monday-token-1')
    saveCredential(null, 'integration_monday_scope', '{ broken json')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = getScopedIntegrationEnv('developmental', 'claude')
    expect(env['MONDAY_TOKEN']).toBeUndefined()
    errSpy.mockRestore()
  })

  it('handles multiple integrations independently in a single call', () => {
    setIntegrationToken('github', 'gh-token')
    setIntegrationToken('linear', 'lin-token')
    setIntegrationScope('linear', { taskTypes: ['daily'], agents: ['claude'] }) // out of scope
    const env = getScopedIntegrationEnv('developmental', 'claude')
    expect(env['GITHUB_TOKEN']).toBe('gh-token')
    expect(env['LINEAR_API_KEY']).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Fake-spawn: runDevTask forwards only in-scope integration credentials
// ═════════════════════════════════════════════════════════════════════════════

/** DevTask fixture: developmental task run by the "claude" agent. */
const baseDevTask: DevTask = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Integration Wiring Test',
  description: '',
  type: 'developmental',
  status: 'idle',
  repoUrl: 'https://github.com/example/test-repo',
  branch: 'main',
  agentId: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

/**
 * A fake DockerService whose `runContainer` never touches a real Docker
 * daemon — it just records the ContainerConfig it was called with and
 * resolves with a successful result, standing in for a container "spawn".
 */
function fakeSpawn(): { service: DockerService; capturedEnv: () => Record<string, string> } {
  let captured: ContainerConfig | undefined
  const result: ContainerLifecycleResult = {
    containerId: 'fake0000000',
    exitCode: 0,
    logs: [],
    timedOut: false,
  }
  const service = {
    runContainer: vi.fn().mockImplementation(async (config: ContainerConfig) => {
      captured = config
      return result
    }),
  } as unknown as DockerService
  return {
    service,
    capturedEnv: () => {
      if (!captured) throw new Error('runContainer was never called')
      return captured.env
    },
  }
}

describe('runDevTask fake-spawn: integration credential injection', () => {
  it('injects an in-scope, connected credential as the documented env var', async () => {
    setIntegrationToken('github', 'gh-secret-token')
    setIntegrationScope('github', { taskTypes: ['developmental'], agents: ['claude'] })

    const { service, capturedEnv } = fakeSpawn()
    const result = await runDevTask(baseDevTask, { dockerService: service })

    expect(result.success).toBe(true)
    expect(capturedEnv()['GITHUB_TOKEN']).toBe('gh-secret-token')
  })

  it('withholds an out-of-scope credential from the spawned container env — proof for the acceptance criteria', async () => {
    // GitHub is connected and in scope for this task's agent (claude).
    setIntegrationToken('github', 'gh-secret-token')
    setIntegrationScope('github', { taskTypes: ['developmental'], agents: ['claude'] })

    // Slack is connected but scoped ONLY to the "opencode" agent — this
    // task runs as "claude", so it must never see the Slack token.
    setIntegrationToken('slack', 'xoxb-should-never-leak')
    setIntegrationScope('slack', { taskTypes: ['developmental'], agents: ['opencode'] })

    // Jira is connected but scoped only to "daily" tasks — this is a
    // developmental task, so it must never see the Jira token either.
    setIntegrationToken('jira', 'jira-should-never-leak')
    setIntegrationScope('jira', { taskTypes: ['daily'], agents: ['claude'] })

    const { service, capturedEnv } = fakeSpawn()
    await runDevTask(baseDevTask, { dockerService: service })

    const env = capturedEnv()
    expect(env['GITHUB_TOKEN']).toBe('gh-secret-token')
    expect(env['SLACK_BOT_TOKEN']).toBeUndefined()
    expect(env['JIRA_API_TOKEN']).toBeUndefined()
    // The out-of-scope secret values must not leak anywhere in the env map
    // (e.g. under the wrong key due to a bug).
    expect(Object.values(env)).not.toContain('xoxb-should-never-leak')
    expect(Object.values(env)).not.toContain('jira-should-never-leak')
  })

  it('withholds a credential for an integration that was never connected', async () => {
    // Notion has an allow-all default scope but no token was ever stored.
    const { service, capturedEnv } = fakeSpawn()
    await runDevTask(baseDevTask, { dockerService: service })

    expect(capturedEnv()['NOTION_TOKEN']).toBeUndefined()
  })

  it('still forwards the core wiring env vars alongside injected credentials', async () => {
    setIntegrationToken('github', 'gh-secret-token')

    const { service, capturedEnv } = fakeSpawn()
    await runDevTask(baseDevTask, { dockerService: service })

    const env = capturedEnv()
    expect(env['REPO_URL']).toBe(baseDevTask.repoUrl)
    expect(env['BRANCH']).toBe(baseDevTask.branch)
    expect(env['AGENT']).toBe(baseDevTask.agentId)
    expect(env['TASK_ID']).toBe(baseDevTask.id)
    expect(env['GITHUB_TOKEN']).toBe('gh-secret-token')
  })

  it('withholds all integration credentials when a different agent runs the same task', async () => {
    setIntegrationToken('github', 'gh-secret-token')
    setIntegrationScope('github', { taskTypes: ['developmental'], agents: ['claude'] })

    const { service, capturedEnv } = fakeSpawn()
    await runDevTask({ ...baseDevTask, agentId: 'opencode' }, { dockerService: service })

    expect(capturedEnv()['GITHUB_TOKEN']).toBeUndefined()
  })

  it('never calls runContainer with a credential in the error path (invalid repoUrl short-circuits first)', async () => {
    setIntegrationToken('github', 'gh-secret-token')
    const { service } = fakeSpawn()

    const result = await runDevTask(
      { ...baseDevTask, repoUrl: 'http://github.com/owner/repo' },
      { dockerService: service },
    )

    expect(result.success).toBe(false)
    expect(service.runContainer).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// No secret leakage
// ═════════════════════════════════════════════════════════════════════════════

describe('secret hygiene', () => {
  it('getIntegrationScope never returns or logs the token value', () => {
    setIntegrationToken('github', 'super-secret-token-value')
    setIntegrationScope('github', { taskTypes: ['developmental'], agents: ['claude'] })
    const scope = getIntegrationScope('github')
    expect(JSON.stringify(scope)).not.toContain('super-secret-token-value')
  })

  it('a corrupt-scope console.error call never includes the raw stored value', () => {
    const rawCorruptValue = 'RAW_CORRUPT_MARKER_not_json'
    saveCredential(null, 'integration_github_scope', rawCorruptValue)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    getIntegrationScope('github')
    for (const call of errSpy.mock.calls) {
      expect(call.join(' ')).not.toContain(rawCorruptValue)
    }
    errSpy.mockRestore()
  })
})
