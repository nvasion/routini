/**
 * Tests for the SSH handler.
 *
 * A fake ssh2 Client is injected via `clientFactory` so no real TCP or
 * SSH traffic is generated. Coverage:
 *   - Input validation (missing fields, SSRF-unsafe host, no credential)
 *   - Successful command execution: stdout/stderr capture, exit-code plumbing
 *   - Output byte-cap truncation for both streams
 *   - Timeout enforcement
 *   - Error message credential scrubbing
 *   - Client error / close events surface as sanitised errors
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Client, ClientChannel } from 'ssh2'
import { runSsh } from '../server/src/tasks/daily/sshHandler.js'
import type { SshConfig } from '../server/src/tasks/types.js'

/**
 * Build a fake ssh2 Client that a handler can call `connect`/`exec` on.
 * The test controls whether the handshake succeeds and what the exec stream
 * emits.
 */
interface FakeClientOptions {
  onConnect?: (client: FakeClient) => void
  onExec?: (
    command: string,
    stream: FakeChannel,
    client: FakeClient,
  ) => void
  execError?: Error
}

class FakeChannel extends PassThrough {
  public stderr = new PassThrough()
}

class FakeClient extends EventEmitter {
  public connected = false
  public ended = false
  public lastCommand: string | null = null

  constructor(private readonly opts: FakeClientOptions) {
    super()
  }

  connect(): this {
    this.connected = true
    setImmediate(() => {
      if (this.opts.onConnect) {
        this.opts.onConnect(this)
      } else {
        this.emit('ready')
      }
    })
    return this
  }

  exec(
    command: string,
    callback: (err: Error | undefined, channel: FakeChannel) => void,
  ): this {
    this.lastCommand = command
    if (this.opts.execError) {
      setImmediate(() => callback(this.opts.execError, new FakeChannel()))
      return this
    }
    const channel = new FakeChannel()
    setImmediate(() => {
      callback(undefined, channel)
      if (this.opts.onExec) this.opts.onExec(command, channel, this)
    })
    return this
  }

  end(): this {
    this.ended = true
    return this
  }
}

function makeConfig(overrides: Partial<SshConfig> = {}): SshConfig {
  return {
    host: 'example.com',
    port: 22,
    username: 'deploy',
    command: 'uptime',
    password: 'supersecret',
    ...overrides,
  }
}

describe('runSsh — validation', () => {
  it('rejects a missing host', async () => {
    await expect(
      runSsh(makeConfig({ host: '' }), { clientFactory: () => new FakeClient({}) as unknown as Client }),
    ).rejects.toThrow(/host is required/)
  })

  it('rejects an SSRF-unsafe host (loopback) even when validation was bypassed', async () => {
    await expect(
      runSsh(makeConfig({ host: '127.0.0.1' }), {
        clientFactory: () => new FakeClient({}) as unknown as Client,
      }),
    ).rejects.toThrow(/disallowed address/)
  })

  it('rejects a missing username', async () => {
    await expect(
      runSsh(makeConfig({ username: '' }), {
        clientFactory: () => new FakeClient({}) as unknown as Client,
      }),
    ).rejects.toThrow(/username is required/)
  })

  it('rejects an empty command', async () => {
    await expect(
      runSsh(makeConfig({ command: '   ' }), {
        clientFactory: () => new FakeClient({}) as unknown as Client,
      }),
    ).rejects.toThrow(/command is required/)
  })

  it('rejects when neither password nor privateKey is provided', async () => {
    await expect(
      runSsh(makeConfig({ password: undefined }), {
        clientFactory: () => new FakeClient({}) as unknown as Client,
      }),
    ).rejects.toThrow(/either password or privateKey/)
  })

  it('rejects a non-positive timeout', async () => {
    await expect(
      runSsh(makeConfig(), {
        timeoutMs: 0,
        clientFactory: () => new FakeClient({}) as unknown as Client,
      }),
    ).rejects.toThrow(/timeoutMs/)
  })

  it('rejects a non-positive output cap', async () => {
    await expect(
      runSsh(makeConfig(), {
        maxOutputBytes: -1,
        clientFactory: () => new FakeClient({}) as unknown as Client,
      }),
    ).rejects.toThrow(/maxOutputBytes/)
  })
})

describe('runSsh — command execution', () => {
  it('returns exit code 0 and captured stdout/stderr on success', async () => {
    const client = new FakeClient({
      onExec: (_cmd, stream) => {
        stream.write(Buffer.from('hello world'))
        stream.stderr.write(Buffer.from('warning: verbose mode'))
        // Close the stream with exit code 0. ssh2 emits `close` on the channel
        // with the exit code and (optional) signal.
        setImmediate(() => stream.emit('close', 0, null))
      },
    })
    const result = await runSsh(makeConfig(), {
      clientFactory: () => client as unknown as Client,
    })
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout).toBe('hello world')
    expect(result.stderr).toBe('warning: verbose mode')
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderrTruncated).toBe(false)
    expect(client.ended).toBe(true)
  })

  it('propagates non-zero exit code and signal', async () => {
    const client = new FakeClient({
      onExec: (_cmd, stream) => {
        setImmediate(() => stream.emit('close', 137, 'SIGKILL'))
      },
    })
    const result = await runSsh(makeConfig(), {
      clientFactory: () => client as unknown as Client,
    })
    expect(result.exitCode).toBe(137)
    expect(result.signal).toBe('SIGKILL')
  })

  it('truncates stdout at maxOutputBytes and flags truncation', async () => {
    const bigOutput = Buffer.alloc(2048, 0x41) // 'A' * 2048
    const client = new FakeClient({
      onExec: (_cmd, stream) => {
        stream.write(bigOutput)
        setImmediate(() => stream.emit('close', 0, null))
      },
    })
    const result = await runSsh(makeConfig(), {
      maxOutputBytes: 100,
      clientFactory: () => client as unknown as Client,
    })
    expect(result.stdout.length).toBe(100)
    expect(result.stdoutTruncated).toBe(true)
  })

  it('truncates stderr independently of stdout', async () => {
    const client = new FakeClient({
      onExec: (_cmd, stream) => {
        stream.write(Buffer.from('ok'))
        stream.stderr.write(Buffer.alloc(1000, 0x42))
        setImmediate(() => stream.emit('close', 0, null))
      },
    })
    const result = await runSsh(makeConfig(), {
      maxOutputBytes: 100,
      clientFactory: () => client as unknown as Client,
    })
    expect(result.stdout).toBe('ok')
    expect(result.stderr.length).toBe(100)
    expect(result.stderrTruncated).toBe(true)
  })

  it('surfaces exec errors through sanitizeError', async () => {
    const client = new FakeClient({ execError: new Error('exec permission denied') })
    await expect(
      runSsh(makeConfig(), { clientFactory: () => client as unknown as Client }),
    ).rejects.toThrow(/ssh exec failed/)
  })

  it('scrubs passwords from thrown error messages', async () => {
    // Simulate ssh2 emitting an error message that echoes the password back.
    const client = new FakeClient({
      onConnect: (c) => {
        setImmediate(() => c.emit('error', new Error('login failed with password=supersecret')))
      },
    })
    await expect(
      runSsh(makeConfig(), { clientFactory: () => client as unknown as Client }),
    ).rejects.toThrow(/\[REDACTED\]/)
    await expect(
      runSsh(makeConfig(), { clientFactory: () => client as unknown as Client }),
    ).rejects.not.toThrow(/supersecret/)
  })

  it('surfaces a client "close" before ready as a sanitised error', async () => {
    const client = new FakeClient({
      onConnect: (c) => {
        setImmediate(() => c.emit('close'))
      },
    })
    await expect(
      runSsh(makeConfig(), { clientFactory: () => client as unknown as Client }),
    ).rejects.toThrow(/closed/)
  })

  it('fires the wall-clock timeout when the handshake never completes', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient({
        // Never emit 'ready' — leave the handshake hanging.
        onConnect: () => undefined,
      })
      const promise = runSsh(makeConfig(), {
        timeoutMs: 100,
        clientFactory: () => client as unknown as Client,
      })
      // Attach the rejection matcher before advancing timers so vitest
      // registers the assertion.
      const assertion = expect(promise).rejects.toThrow(/timed out after 100ms/)
      await vi.advanceTimersByTimeAsync(100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

// Silence "type imports" ESLint complaint if the compiler tree-shakes it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ChannelType = ClientChannel
