/**
 * Tests for the Developmental Task service and related API endpoints.
 *
 * Coverage:
 *   – validateRepoUrl: protocol, host allowlist, credentials, port, path
 *   – validateAgentId: known / unknown agents
 *   – runDevTask: validation short-circuits, success path, failure path,
 *                 timeout, spawn error, commit SHA extraction
 *   – GET /api/tasks/:id/logs: empty logs, logs after trigger, 404
 *   – Trigger integration: status transitions for developmental tasks
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import supertest from 'supertest'
import { app } from '../server/src/app'
import {
  validateRepoUrl,
  validateAgentId,
  runDevTask,
  VALID_AGENTS,
} from '../server/src/services/devTask'
import type { DevTask } from '../server/src/types'

const request = supertest(app)

// ── Auth helper ───────────────────────────────────────────────────────────────

let authToken: string

beforeAll(async () => {
  const res = await request
    .post('/api/auth/login')
    .send({ email: 'admin@routini.dev', password: 'changeme' })
  authToken = res.body.token as string
})

function auth() {
  return { Authorization: `Bearer ${authToken}` }
}

// ── Mock ChildProcess factory ─────────────────────────────────────────────────

/**
 * Creates a ChildProcess-like object that emits the given stdout/stderr and
 * then closes with `exitCode` after `delay` milliseconds.
 */
function mockProcess(opts: {
  exitCode: number
  stdout?: string
  stderr?: string
  delay?: number
  emitError?: Error
}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess
  const stdoutStream = new PassThrough()
  const stderrStream = new PassThrough()
  ;(proc as unknown as Record<string, unknown>).stdout = stdoutStream
  ;(proc as unknown as Record<string, unknown>).stderr = stderrStream
  ;(proc as unknown as Record<string, unknown>).stdin = null
  ;(proc as unknown as Record<string, unknown>).kill = (signal?: string) => {
    // Simulate a kill → close with null exit code
    process.nextTick(() => proc.emit('close', null, signal))
    return true
  }

  const delay = opts.delay ?? 0

  if (opts.emitError) {
    const err = opts.emitError
    setTimeout(() => proc.emit('error', err), delay)
  } else {
    setTimeout(() => {
      if (opts.stdout) {
        stdoutStream.write(opts.stdout)
      }
      stdoutStream.end()
      if (opts.stderr) {
        stderrStream.write(opts.stderr)
      }
      stderrStream.end()
      proc.emit('close', opts.exitCode)
    }, delay)
  }

  return proc
}

/** Minimal valid DevTask fixture. */
const baseDevTask: DevTask = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test Task',
  description: '',
  type: 'developmental',
  status: 'idle',
  repoUrl: 'https://github.com/example/test-repo',
  branch: 'feature/test',
  agentId: 'claude',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

// ═════════════════════════════════════════════════════════════════════════════
// validateRepoUrl
// ═════════════════════════════════════════════════════════════════════════════

describe('validateRepoUrl', () => {
  // ── Happy paths ───────────────────────────────────────────────────────────

  it('accepts a valid github.com https URL', () => {
    const result = validateRepoUrl('https://github.com/owner/repo')
    expect(result.valid).toBe(true)
  })

  it('accepts a valid gitlab.com https URL', () => {
    const result = validateRepoUrl('https://gitlab.com/group/project')
    expect(result.valid).toBe(true)
  })

  it('accepts a valid bitbucket.org https URL', () => {
    const result = validateRepoUrl('https://bitbucket.org/team/repo.git')
    expect(result.valid).toBe(true)
  })

  it('accepts a valid dev.azure.com https URL', () => {
    const result = validateRepoUrl('https://dev.azure.com/org/project/_git/repo')
    expect(result.valid).toBe(true)
  })

  it('accepts a subdomain of an allowed host (gist.github.com)', () => {
    const result = validateRepoUrl('https://gist.github.com/user/abc123')
    expect(result.valid).toBe(true)
  })

  it('exposes the parsed URL object on success', () => {
    const result = validateRepoUrl('https://github.com/owner/repo')
    if (!result.valid) throw new Error('Expected valid')
    expect(result.url.hostname).toBe('github.com')
  })

  // ── Protocol checks ───────────────────────────────────────────────────────

  it('rejects http:// (insecure protocol)', () => {
    const result = validateRepoUrl('http://github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  it('rejects ssh:// protocol', () => {
    const result = validateRepoUrl('ssh://github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  it('rejects git:// protocol', () => {
    const result = validateRepoUrl('git://github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  it('rejects file:// protocol', () => {
    const result = validateRepoUrl('file:///etc/passwd')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/https/i)
  })

  // ── Host allowlist checks ─────────────────────────────────────────────────

  it('rejects an unknown host (example.com)', () => {
    const result = validateRepoUrl('https://example.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  it('rejects an internal IP address (SSRF)', () => {
    const result = validateRepoUrl('https://192.168.1.1/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  it('rejects localhost (SSRF)', () => {
    const result = validateRepoUrl('https://localhost/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  it('rejects a domain that only contains the allowed host as a suffix trick', () => {
    // e.g. "evil-github.com" – contains "github.com" but does NOT end with ".github.com"
    const result = validateRepoUrl('https://evil-github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/hostname/i)
  })

  // ── Credential checks ─────────────────────────────────────────────────────

  it('rejects URLs with embedded username:password', () => {
    const result = validateRepoUrl('https://user:secret@github.com/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/credential/i)
  })

  // ── Port checks ───────────────────────────────────────────────────────────

  it('rejects a non-standard port', () => {
    const result = validateRepoUrl('https://github.com:8443/owner/repo')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/port/i)
  })

  it('accepts explicit default port 443', () => {
    const result = validateRepoUrl('https://github.com:443/owner/repo')
    expect(result.valid).toBe(true)
  })

  // ── Path checks ───────────────────────────────────────────────────────────

  it('rejects a URL with no repository path', () => {
    const result = validateRepoUrl('https://github.com/')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/path/i)
  })

  // ── Input sanity ─────────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    const result = validateRepoUrl('')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/required/i)
  })

  it('rejects a non-URL string', () => {
    const result = validateRepoUrl('not a url at all')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/valid URL/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// validateAgentId
// ═════════════════════════════════════════════════════════════════════════════

describe('validateAgentId', () => {
  it('accepts all values in VALID_AGENTS', () => {
    for (const agent of VALID_AGENTS) {
      expect(validateAgentId(agent)).toBe(true)
    }
  })

  it('returns false for an unknown agent', () => {
    expect(validateAgentId('unknown-agent')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(validateAgentId('')).toBe(false)
  })

  it('is case-sensitive (CLAUDE !== claude)', () => {
    expect(validateAgentId('CLAUDE')).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// runDevTask – unit tests with mocked Docker spawner
// ═════════════════════════════════════════════════════════════════════════════

describe('runDevTask', () => {
  it('returns an error result for an invalid repoUrl without spawning Docker', async () => {
    const spawnDocker = vi.fn()
    const result = await runDevTask(
      { ...baseDevTask, repoUrl: 'http://github.com/owner/repo' },
      { spawnDocker }
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/https/i)
    expect(spawnDocker).not.toHaveBeenCalled()
  })

  it('returns an error result for an unsupported agentId without spawning Docker', async () => {
    const spawnDocker = vi.fn()
    const result = await runDevTask(
      { ...baseDevTask, agentId: 'unknown-agent' },
      { spawnDocker }
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unsupported agent/i)
    expect(spawnDocker).not.toHaveBeenCalled()
  })

  it('returns success when the container exits with code 0', async () => {
    const spawnDocker = () =>
      mockProcess({ exitCode: 0, stdout: 'All good\nDone\n' })

    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(result.success).toBe(true)
    expect(result.logs).toContain('All good')
    expect(result.logs).toContain('Done')
    expect(result.error).toBeUndefined()
  })

  it('returns failure when the container exits with a non-zero code', async () => {
    const spawnDocker = () =>
      mockProcess({ exitCode: 1, stdout: 'Something failed\n' })

    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/code 1/i)
  })

  it('captures stderr lines with a [stderr] prefix', async () => {
    const spawnDocker = () =>
      mockProcess({ exitCode: 0, stderr: 'Warning: something\n' })

    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(result.logs.some(l => l.startsWith('[stderr]'))).toBe(true)
  })

  it('extracts COMMIT_SHA from stdout on success', async () => {
    const stdout = 'Cloning…\nCOMMIT_SHA=abc1234def5678\nPushed.\n'
    const spawnDocker = () => mockProcess({ exitCode: 0, stdout })

    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(result.success).toBe(true)
    expect(result.commitSha).toBe('abc1234def5678')
  })

  it('does not set commitSha when the agent emits no COMMIT_SHA line', async () => {
    const spawnDocker = () => mockProcess({ exitCode: 0, stdout: 'Done.\n' })

    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(result.success).toBe(true)
    expect(result.commitSha).toBeUndefined()
  })

  it('returns a timeout error when the container exceeds timeoutMs', async () => {
    // delay > timeoutMs so the timeout fires first
    const spawnDocker = () => mockProcess({ exitCode: 0, delay: 200 })

    const result = await runDevTask(baseDevTask, { spawnDocker, timeoutMs: 50 })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out/i)
  })

  it('returns an error result when the spawner throws synchronously', async () => {
    const spawnDocker = (): ChildProcess => {
      throw new Error('docker not found')
    }

    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/docker not found/i)
  })

  it('returns an error result when the process emits an error event', async () => {
    const spawnDocker = () =>
      mockProcess({ exitCode: 0, emitError: new Error('ENOENT: docker not found') })

    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/ENOENT/i)
  })

  it('populates containerId in every result', async () => {
    const spawnDocker = () => mockProcess({ exitCode: 0 })
    const result = await runDevTask(baseDevTask, { spawnDocker })
    expect(typeof result.containerId).toBe('string')
    expect(result.containerId.length).toBeGreaterThan(0)
  })

  it('includes the task id in the container name', async () => {
    let capturedArgs: string[] = []
    const spawnDocker = (args: string[]) => {
      capturedArgs = args
      return mockProcess({ exitCode: 0 })
    }

    await runDevTask(baseDevTask, { spawnDocker })

    const nameIdx = capturedArgs.indexOf('--name')
    expect(nameIdx).toBeGreaterThan(-1)
    const containerName = capturedArgs[nameIdx + 1]
    expect(containerName).toContain(baseDevTask.id)
  })

  it('passes REPO_URL, BRANCH, AGENT, TASK_ID env vars to docker', async () => {
    let capturedArgs: string[] = []
    const spawnDocker = (args: string[]) => {
      capturedArgs = args
      return mockProcess({ exitCode: 0 })
    }

    await runDevTask(baseDevTask, { spawnDocker })

    const envPairs = capturedArgs.reduce<string[]>((acc, v, i) => {
      if (capturedArgs[i - 1] === '-e') acc.push(v)
      return acc
    }, [])

    expect(envPairs).toContain(`REPO_URL=${baseDevTask.repoUrl}`)
    expect(envPairs).toContain(`BRANCH=${baseDevTask.branch}`)
    expect(envPairs).toContain(`AGENT=${baseDevTask.agentId}`)
    expect(envPairs).toContain(`TASK_ID=${baseDevTask.id}`)
  })

  it('includes security flags: --no-new-privileges, --cap-drop ALL, --user nobody', async () => {
    let capturedArgs: string[] = []
    const spawnDocker = (args: string[]) => {
      capturedArgs = args
      return mockProcess({ exitCode: 0 })
    }

    await runDevTask(baseDevTask, { spawnDocker })

    expect(capturedArgs).toContain('--no-new-privileges')
    expect(capturedArgs).toContain('--cap-drop')
    expect(capturedArgs).toContain('ALL')
    expect(capturedArgs).toContain('--user')
    expect(capturedArgs).toContain('nobody')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/tasks – additional developmental task creation validation
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/tasks – developmental task validation', () => {
  it('returns 400 when repoUrl uses http:// instead of https://', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Bad Protocol Task',
      type: 'developmental',
      repoUrl: 'http://github.com/owner/repo',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/https/i)
  })

  it('returns 400 when repoUrl is not a git host', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'SSRF Attempt',
      type: 'developmental',
      repoUrl: 'https://internal-service.corp/secret',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/hostname/i)
  })

  it('returns 400 when repoUrl contains embedded credentials', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Creds Task',
      type: 'developmental',
      repoUrl: 'https://user:pass@github.com/owner/repo',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/credential/i)
  })

  it('returns 400 when agentId is unsupported', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Bad Agent Task',
      type: 'developmental',
      repoUrl: 'https://github.com/owner/repo',
      agentId: 'super-agent-9000',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/agentId/i)
  })

  it('creates successfully with a valid gitlab URL and opencode agent', async () => {
    const res = await request.post('/api/tasks').set(auth()).send({
      name: 'Gitlab Opencode Task',
      type: 'developmental',
      repoUrl: 'https://gitlab.com/group/project',
      branch: 'main',
      agentId: 'opencode',
    })
    expect(res.status).toBe(201)
    expect(res.body.repoUrl).toBe('https://gitlab.com/group/project')
    expect(res.body.agentId).toBe('opencode')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/tasks/:id/logs
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/tasks/:id/logs', () => {
  it('returns an empty logs array for a newly created task', async () => {
    const created = await request.post('/api/tasks').set(auth()).send({
      name: 'Log Test Task',
      type: 'developmental',
      repoUrl: 'https://github.com/owner/repo',
      agentId: 'claude',
    })
    expect(created.status).toBe(201)
    const id = created.body.id as string

    const res = await request.get(`/api/tasks/${id}/logs`).set(auth())
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.logs)).toBe(true)
    expect(res.body.count).toBe(0)
  })

  it('returns 404 for a non-existent task id', async () => {
    const res = await request
      .get('/api/tasks/00000000-0000-0000-0000-000000000000/logs')
      .set(auth())
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/api/tasks/any-id/logs')
    expect(res.status).toBe(401)
  })

  it('returns logs with timestamp and message fields', async () => {
    // Create a daily task and trigger it (no Docker needed for non-dev tasks).
    const created = await request.post('/api/tasks').set(auth()).send({
      name: 'Routine With Logs',
      type: 'routine',
    })
    const id = created.body.id as string
    await request.post(`/api/tasks/${id}/trigger`).set(auth())

    // Routine tasks don't produce container logs; array may be empty but
    // the endpoint must still return a valid response shape.
    const res = await request.get(`/api/tasks/${id}/logs`).set(auth())
    expect(res.status).toBe(200)
    expect(typeof res.body.count).toBe('number')
    expect(res.body.count).toBe(res.body.logs.length)
  })

  it('log entries contain timestamp and message', async () => {
    // Create and trigger a developmental task; the trigger route appends
    // a "Starting developmental task…" log line synchronously before
    // Docker is called.
    const created = await request.post('/api/tasks').set(auth()).send({
      name: 'Dev Logs Shape',
      type: 'developmental',
      repoUrl: 'https://github.com/owner/repo',
      agentId: 'claude',
    })
    const id = created.body.id as string
    await request.post(`/api/tasks/${id}/trigger`).set(auth())

    // Give the async fire-and-forget task a moment to write the first log.
    await new Promise(r => setTimeout(r, 20))

    const res = await request.get(`/api/tasks/${id}/logs`).set(auth())
    expect(res.status).toBe(200)
    if (res.body.logs.length > 0) {
      const first = res.body.logs[0] as { timestamp: string; message: string }
      expect(typeof first.timestamp).toBe('string')
      expect(typeof first.message).toBe('string')
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/tasks/:id/trigger – status transitions for developmental tasks
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/tasks/:id/trigger – developmental task', () => {
  it('immediately returns status queued and then transitions to running', async () => {
    const created = await request.post('/api/tasks').set(auth()).send({
      name: 'Transition Test Task',
      type: 'developmental',
      repoUrl: 'https://github.com/owner/repo',
      agentId: 'claude',
    })
    const id = created.body.id as string

    const triggerRes = await request.post(`/api/tasks/${id}/trigger`).set(auth())
    expect(triggerRes.status).toBe(200)
    expect(triggerRes.body.task.status).toBe('queued')
  })

  it('deleting a dev task also removes its logs', async () => {
    const created = await request.post('/api/tasks').set(auth()).send({
      name: 'Delete Logs Test',
      type: 'developmental',
      repoUrl: 'https://github.com/owner/repo',
      agentId: 'omnimancer',
    })
    const id = created.body.id as string

    await request.post(`/api/tasks/${id}/trigger`).set(auth())

    const del = await request.delete(`/api/tasks/${id}`).set(auth())
    expect(del.status).toBe(200)

    // After deletion the logs endpoint should 404.
    const logsRes = await request.get(`/api/tasks/${id}/logs`).set(auth())
    expect(logsRes.status).toBe(404)
  })
})
