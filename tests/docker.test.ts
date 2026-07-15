/**
 * Tests for the DockerService and parseDockerLogs utility.
 *
 * Coverage:
 *   – parseDockerLogs: stdout frames, stderr frames, multi-frame buffers,
 *                      empty payloads, malformed/truncated headers
 *   – DockerService.runContainer:
 *       success (exit 0), failure (non-zero exit), timeout (kill path),
 *       createContainer error, container.start() error,
 *       log collection + parsing, container removal, resource limits,
 *       security controls (CapDrop, SecurityOpt, User), env-var forwarding,
 *       containerId truncation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Dockerode from 'dockerode'
import {
  DockerService,
  parseDockerLogs,
  type ContainerConfig,
  type ContainerLifecycleResult,
} from '../server/src/services/docker'

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Builds a Docker multiplexed-log frame.
 *   streamType: 1 = stdout, 2 = stderr
 */
function makeFrame(streamType: 1 | 2, payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = streamType
  header.writeUInt32BE(payloadBuf.length, 4)
  return Buffer.concat([header, payloadBuf])
}

/** Creates a minimal mock Dockerode.Container. */
function makeMockContainer(opts: {
  waitResult?: { StatusCode: number }
  waitDelay?: number          // ms to delay the wait resolution
  waitError?: Error
  logsResult?: Buffer
  startError?: Error
} = {}) {
  const {
    waitResult = { StatusCode: 0 },
    waitDelay = 0,
    waitError,
    logsResult = Buffer.alloc(0),
    startError,
  } = opts

  const waitFn = waitError
    ? vi.fn().mockRejectedValue(waitError)
    : vi.fn().mockImplementation(
        () =>
          new Promise<{ StatusCode: number }>(resolve =>
            setTimeout(() => resolve(waitResult), waitDelay)
          )
      )

  return {
    id: 'abc123def456789012345678',   // 24 hex chars; service truncates to 12
    start: startError
      ? vi.fn().mockRejectedValue(startError)
      : vi.fn().mockResolvedValue(undefined),
    wait:   waitFn,
    kill:   vi.fn().mockResolvedValue(undefined),
    logs:   vi.fn().mockResolvedValue(logsResult),
    remove: vi.fn().mockResolvedValue(undefined),
  }
}

type MockContainer = ReturnType<typeof makeMockContainer>

function makeMockDockerode(container: MockContainer): Dockerode {
  return {
    createContainer: vi.fn().mockResolvedValue(container),
  } as unknown as Dockerode
}

const BASE_CONFIG: ContainerConfig = {
  image: 'routini/test-agent:latest',
  name:  'test-container',
  env:   { FOO: 'bar', BAZ: 'qux' },
}

// ═════════════════════════════════════════════════════════════════════════════
// parseDockerLogs
// ═════════════════════════════════════════════════════════════════════════════

describe('parseDockerLogs', () => {
  it('parses a stdout frame (streamType 1)', () => {
    const buf = makeFrame(1, 'hello world\n')
    const out: string[] = []
    parseDockerLogs(buf, out)
    expect(out).toEqual(['hello world'])
  })

  it('parses a stderr frame with [stderr] prefix (streamType 2)', () => {
    const buf = makeFrame(2, 'error occurred\n')
    const out: string[] = []
    parseDockerLogs(buf, out)
    expect(out).toEqual(['[stderr] error occurred'])
  })

  it('handles multiple frames in sequence', () => {
    const buf = Buffer.concat([
      makeFrame(1, 'line 1\n'),
      makeFrame(2, 'err line\n'),
      makeFrame(1, 'line 2\n'),
    ])
    const out: string[] = []
    parseDockerLogs(buf, out)
    expect(out).toEqual(['line 1', '[stderr] err line', 'line 2'])
  })

  it('skips blank and whitespace-only lines', () => {
    const buf = makeFrame(1, '\n   \n\t\n')
    const out: string[] = []
    parseDockerLogs(buf, out)
    expect(out).toEqual([])
  })

  it('handles an empty buffer without throwing', () => {
    const out: string[] = []
    parseDockerLogs(Buffer.alloc(0), out)
    expect(out).toEqual([])
  })

  it('skips a frame whose payload size is zero', () => {
    const header = Buffer.alloc(8)
    header[0] = 1
    header.writeUInt32BE(0, 4)
    const out: string[] = []
    parseDockerLogs(header, out)
    expect(out).toEqual([])
  })

  it('stops gracefully when a frame extends beyond the buffer boundary', () => {
    // Payload claims 100 bytes but only 5 are available.
    const header = Buffer.alloc(8)
    header[0] = 1
    header.writeUInt32BE(100, 4)
    const truncated = Buffer.concat([header, Buffer.from('short')])
    const out: string[] = []
    parseDockerLogs(truncated, out)
    expect(out).toEqual([])
  })

  it('splits a multi-line payload into separate entries', () => {
    const buf = makeFrame(1, 'line A\nline B\nline C\n')
    const out: string[] = []
    parseDockerLogs(buf, out)
    expect(out).toEqual(['line A', 'line B', 'line C'])
  })

  it('does not mutate the output array beyond appending', () => {
    const out = ['pre-existing']
    parseDockerLogs(makeFrame(1, 'new line\n'), out)
    expect(out[0]).toBe('pre-existing')
    expect(out[1]).toBe('new line')
    expect(out).toHaveLength(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// DockerService.runContainer
// ═════════════════════════════════════════════════════════════════════════════

describe('DockerService.runContainer', () => {
  // ── Exit-code paths ───────────────────────────────────────────────────────

  it('returns exitCode 0 and no error when container exits successfully', async () => {
    const container = makeMockContainer({ waitResult: { StatusCode: 0 } })
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.error).toBeUndefined()
  })

  it('returns non-zero exitCode when container exits with failure', async () => {
    const container = makeMockContainer({ waitResult: { StatusCode: 2 } })
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.exitCode).toBe(2)
    expect(result.timedOut).toBe(false)
    expect(result.error).toBeUndefined()
  })

  // ── Timeout path ──────────────────────────────────────────────────────────

  it('sets timedOut and kills the container when timeout elapses', async () => {
    const container = makeMockContainer({ waitDelay: 500 })   // wait > timeout
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 50)

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(container.kill).toHaveBeenCalled()
  }, 10_000)

  it('still removes the container after a timeout', async () => {
    const container = makeMockContainer({ waitDelay: 500 })
    const service = new DockerService(makeMockDockerode(container))

    await service.runContainer(BASE_CONFIG, 50)

    expect(container.remove).toHaveBeenCalledWith({ force: true })
  }, 10_000)

  // ── Infrastructure errors ─────────────────────────────────────────────────

  it('returns an error result with empty containerId when createContainer throws', async () => {
    const mockDocker = {
      createContainer: vi.fn().mockRejectedValue(new Error('image not found')),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.containerId).toBe('')
    expect(result.error).toMatch(/image not found/i)
    expect(result.logs).toEqual([])
    expect(result.timedOut).toBe(false)
  })

  it('returns an error and removes the container when container.start() throws', async () => {
    const container = makeMockContainer({ startError: new Error('port already in use') })
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.error).toMatch(/port already in use/i)
    expect(container.remove).toHaveBeenCalledWith({ force: true })
  })

  // ── Log collection ────────────────────────────────────────────────────────

  it('parses stdout and stderr from the container logs buffer', async () => {
    const logBuf = Buffer.concat([
      makeFrame(1, 'stdout line\n'),
      makeFrame(2, 'stderr line\n'),
    ])
    const container = makeMockContainer({ logsResult: logBuf })
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.logs).toContain('stdout line')
    expect(result.logs).toContain('[stderr] stderr line')
  })

  it('returns an empty logs array when the container emits no output', async () => {
    const container = makeMockContainer({ logsResult: Buffer.alloc(0) })
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.logs).toEqual([])
  })

  it('collects logs even when the container exits with a non-zero code', async () => {
    const logBuf = makeFrame(1, 'error: build failed\n')
    const container = makeMockContainer({
      waitResult: { StatusCode: 1 },
      logsResult: logBuf,
    })
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain('error: build failed')
  })

  // ── Container cleanup ─────────────────────────────────────────────────────

  it('removes the container with force:true after a successful run', async () => {
    const container = makeMockContainer()
    const service = new DockerService(makeMockDockerode(container))

    await service.runContainer(BASE_CONFIG, 60_000)

    expect(container.remove).toHaveBeenCalledWith({ force: true })
  })

  it('removes the container with force:true after a start failure', async () => {
    const container = makeMockContainer({ startError: new Error('oops') })
    const service = new DockerService(makeMockDockerode(container))

    await service.runContainer(BASE_CONFIG, 60_000)

    expect(container.remove).toHaveBeenCalledWith({ force: true })
  })

  // ── Resource limits ───────────────────────────────────────────────────────

  it('applies default resource limits (512 MiB, 1 CPU)', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer(BASE_CONFIG, 60_000)

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.HostConfig?.Memory).toBe(512 * 1024 * 1024)
    expect(opts.HostConfig?.NanoCpus).toBe(1_000_000_000)
  })

  it('applies custom memory and CPU limits from ContainerConfig', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer(
      { ...BASE_CONFIG, memoryBytes: 256 * 1024 * 1024, cpuCount: 0.5 },
      60_000
    )

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.HostConfig?.Memory).toBe(256 * 1024 * 1024)
    expect(opts.HostConfig?.NanoCpus).toBe(Math.round(0.5 * 1e9))
  })

  // ── Security controls ─────────────────────────────────────────────────────

  it('enforces CapDrop ALL by default', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer(BASE_CONFIG, 60_000)

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.HostConfig?.CapDrop).toEqual(['ALL'])
  })

  it('sets no-new-privileges:true in SecurityOpt by default', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer(BASE_CONFIG, 60_000)

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.HostConfig?.SecurityOpt).toContain('no-new-privileges:true')
  })

  it('runs as "nobody" user by default', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer(BASE_CONFIG, 60_000)

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.User).toBe('nobody')
  })

  it('accepts custom user, capDrop, and memoryBytes overrides', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer(
      { ...BASE_CONFIG, user: 'agent', capDrop: ['NET_ADMIN', 'SYS_ADMIN'] },
      60_000
    )

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.User).toBe('agent')
    expect(opts.HostConfig?.CapDrop).toEqual(['NET_ADMIN', 'SYS_ADMIN'])
  })

  // ── Environment variables ─────────────────────────────────────────────────

  it('passes environment variables as KEY=VALUE strings', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer(
      { ...BASE_CONFIG, env: { KEY1: 'val1', KEY2: 'val2' } },
      60_000
    )

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.Env).toContain('KEY1=val1')
    expect(opts.Env).toContain('KEY2=val2')
  })

  it('passes an empty Env array when no env vars are provided', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer({ ...BASE_CONFIG, env: {} }, 60_000)

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.Env).toEqual([])
  })

  // ── containerId ───────────────────────────────────────────────────────────

  it('truncates the full container ID to 12 characters', async () => {
    const container = makeMockContainer()   // id length = 24
    const service = new DockerService(makeMockDockerode(container))

    const result = await service.runContainer(BASE_CONFIG, 60_000)

    expect(result.containerId).toBe('abc123def456')
    expect(result.containerId).toHaveLength(12)
  })

  it('uses the container name in the createContainer call', async () => {
    const container = makeMockContainer()
    const mockDocker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await service.runContainer({ ...BASE_CONFIG, name: 'my-unique-container' }, 60_000)

    const opts = (mockDocker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0] as Dockerode.ContainerCreateOptions
    expect(opts.name).toBe('my-unique-container')
  })

  // ── Input sanitization ────────────────────────────────────────────────────

  it('throws synchronously when an env var key is empty', async () => {
    const service = new DockerService()
    await expect(
      service.runContainer({ ...BASE_CONFIG, env: { '': 'value' } }, 60_000)
    ).rejects.toThrow(/Invalid environment variable key/)
  })

  it('throws when an env var key contains non-identifier characters', async () => {
    const service = new DockerService()
    await expect(
      service.runContainer({ ...BASE_CONFIG, env: { 'bad-key!': 'value' } }, 60_000)
    ).rejects.toThrow(/Invalid environment variable key/)
  })

  it('throws when an env var value contains a null byte', async () => {
    const service = new DockerService()
    await expect(
      service.runContainer({ ...BASE_CONFIG, env: { VALID: 'val\0ue' } }, 60_000)
    ).rejects.toThrow(/null byte/)
  })

  it('does not call createContainer when env var validation fails', async () => {
    const mockDocker = {
      createContainer: vi.fn(),
    } as unknown as Dockerode
    const service = new DockerService(mockDocker)

    await expect(
      service.runContainer({ ...BASE_CONFIG, env: { '': 'bad' } }, 60_000)
    ).rejects.toThrow()

    expect(mockDocker.createContainer).not.toHaveBeenCalled()
  })
})
