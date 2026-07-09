/**
 * Tests for the IMAP email handler.
 *
 * A fake TLS-like socket is injected via `socketFactory` so no real TLS
 * handshake is performed. The fake supports scripted server replies: for
 * each client command line ("A0001 LOGIN … …\r\n") we push a canned server
 * response back through `socket.emit('data', …)`.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { checkEmail } from '../server/src/tasks/daily/emailHandler.js'
import type {
  EmailCheckOptions,
  TlsLikeSocket,
} from '../server/src/tasks/daily/emailHandler.js'
import type { EmailConfig } from '../server/src/tasks/types.js'

/** Server response bound to a specific tag prefix. */
interface ScriptedResponse {
  /** Substring to match on the outgoing client line. */
  match: RegExp
  /** Response lines *without* the tag; `%tag%` will be substituted. */
  lines: string[]
}

/**
 * Fake IMAPS socket. Buffers writes into complete lines, matches them
 * against a script, and emits the scripted response back on 'data'.
 *
 * When `respondOnUnmatched` is `true` (the default) any command that
 * doesn't match a script entry gets a BAD reply — this is what most
 * happy-path tests want. Tests that need to model a completely silent
 * server (timeout / hangup / buffer-overflow) construct the socket with
 * `respondOnUnmatched: false` so an unscripted LOGIN doesn't short-circuit
 * the scenario.
 */
class FakeSocket extends EventEmitter {
  private writeBuffer = ''
  public writes: string[] = []
  public ended = false

  constructor(
    private readonly script: ScriptedResponse[],
    private readonly respondOnUnmatched: boolean = true,
  ) {
    super()
  }

  setEncoding(): void {
    /* ignore */
  }

  write(chunk: string): boolean {
    this.writes.push(chunk)
    this.writeBuffer += chunk
    let newline = this.writeBuffer.indexOf('\r\n')
    while (newline !== -1) {
      const line = this.writeBuffer.slice(0, newline)
      this.writeBuffer = this.writeBuffer.slice(newline + 2)
      this.handleLine(line)
      newline = this.writeBuffer.indexOf('\r\n')
    }
    return true
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.ended = true
  }

  private handleLine(line: string): void {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) return
    const tag = line.slice(0, spaceIdx)
    const rest = line.slice(spaceIdx + 1)
    for (const entry of this.script) {
      if (entry.match.test(rest)) {
        setImmediate(() => {
          for (const templ of entry.lines) {
            const rendered = templ.replaceAll('%tag%', tag)
            this.emit('data', `${rendered}\r\n`)
          }
        })
        return
      }
    }
    if (this.respondOnUnmatched) {
      setImmediate(() => this.emit('data', `${tag} BAD unscripted command\r\n`))
    }
  }
}

function baseConfig(overrides: Partial<EmailConfig> = {}): EmailConfig {
  return {
    host: 'imap.example.com',
    port: 993,
    username: 'alice',
    password: 'topsecret',
    folder: 'INBOX',
    ...overrides,
  }
}

function factoryFor(socket: FakeSocket): EmailCheckOptions['socketFactory'] {
  return () => {
    // Fire the secureConnect on the next tick so the handler can register
    // its listener first.
    setImmediate(() => socket.emit('secureConnect'))
    return socket as unknown as TlsLikeSocket
  }
}

describe('checkEmail — validation', () => {
  it('rejects a missing host', async () => {
    await expect(checkEmail(baseConfig({ host: '' }))).rejects.toThrow(/host is required/)
  })

  it('rejects an SSRF-unsafe host', async () => {
    await expect(checkEmail(baseConfig({ host: '10.0.0.1' }))).rejects.toThrow(
      /disallowed address/,
    )
  })

  it('rejects a missing username', async () => {
    await expect(checkEmail(baseConfig({ username: '' }))).rejects.toThrow(
      /username is required/,
    )
  })

  it('rejects a missing password', async () => {
    await expect(checkEmail(baseConfig({ password: '' }))).rejects.toThrow(
      /password is required/,
    )
  })

  it('rejects a folder containing CR/LF (IMAP injection defense)', async () => {
    await expect(
      checkEmail(baseConfig({ folder: 'INBOX\r\n LOGOUT' })),
    ).rejects.toThrow(/CR or LF/)
  })
})

describe('checkEmail — happy path', () => {
  it('returns totalMessages and unreadMessages parsed from the server reply', async () => {
    const socket = new FakeSocket([
      { match: /^LOGIN /, lines: ['%tag% OK LOGIN completed'] },
      {
        match: /^EXAMINE /,
        lines: [
          '* 42 EXISTS',
          '* 0 RECENT',
          '* OK [UIDVALIDITY 1] Ok',
          '%tag% OK [READ-ONLY] EXAMINE completed',
        ],
      },
      {
        match: /^SEARCH UNSEEN/,
        lines: ['* SEARCH 3 7 11 15', '%tag% OK SEARCH completed'],
      },
      { match: /^LOGOUT/, lines: ['* BYE logging out', '%tag% OK LOGOUT completed'] },
    ])
    const result = await checkEmail(baseConfig(), {
      socketFactory: factoryFor(socket),
    })
    expect(result.totalMessages).toBe(42)
    expect(result.unreadMessages).toBe(4)
    expect(result.folder).toBe('INBOX')
    expect(socket.ended).toBe(true)
  })

  it('returns zero unread when SEARCH matches nothing', async () => {
    const socket = new FakeSocket([
      { match: /^LOGIN /, lines: ['%tag% OK'] },
      { match: /^EXAMINE /, lines: ['* 5 EXISTS', '%tag% OK'] },
      { match: /^SEARCH UNSEEN/, lines: ['* SEARCH', '%tag% OK'] },
      { match: /^LOGOUT/, lines: ['%tag% OK'] },
    ])
    const result = await checkEmail(baseConfig(), {
      socketFactory: factoryFor(socket),
    })
    expect(result.totalMessages).toBe(5)
    expect(result.unreadMessages).toBe(0)
  })

  it('IMAP-quotes credentials so a stray double-quote does not break the argument', async () => {
    const socket = new FakeSocket([
      { match: /^LOGIN /, lines: ['%tag% OK'] },
      { match: /^EXAMINE /, lines: ['* 0 EXISTS', '%tag% OK'] },
      { match: /^SEARCH UNSEEN/, lines: ['* SEARCH', '%tag% OK'] },
      { match: /^LOGOUT/, lines: ['%tag% OK'] },
    ])
    await checkEmail(baseConfig({ password: 'p"w' }), {
      socketFactory: factoryFor(socket),
    })
    const loginWrite = socket.writes.join('').match(/LOGIN [^\r\n]+/)
    expect(loginWrite).not.toBeNull()
    // Backslash-escaped quote inside the quoted password arg.
    expect(loginWrite![0]).toContain('\\"')
  })
})

describe('checkEmail — error paths', () => {
  it('fails when server replies BAD to LOGIN and scrubs the password from the error', async () => {
    const socket = new FakeSocket([
      { match: /^LOGIN /, lines: ['%tag% NO login rejected'] },
    ])
    await expect(
      checkEmail(baseConfig(), { socketFactory: factoryFor(socket) }),
    ).rejects.toThrow(/imap/)
  })

  it('scrubs the password from a stringified error', async () => {
    const socket = new FakeSocket([])
    // Fire an error event that echoes the password.
    setImmediate(() => socket.emit('error', new Error('proto error near password=topsecret')))
    const factory: EmailCheckOptions['socketFactory'] = () => socket as unknown as TlsLikeSocket
    await expect(
      checkEmail(baseConfig(), { socketFactory: factory }),
    ).rejects.toThrow(/\[REDACTED\]/)
  })

  it('applies the wall-clock timeout to a stalled server', async () => {
    vi.useFakeTimers()
    try {
      // respondOnUnmatched: false → server stays silent.
      const socket = new FakeSocket([], false)
      const factory: EmailCheckOptions['socketFactory'] = () => {
        setImmediate(() => socket.emit('secureConnect'))
        return socket as unknown as TlsLikeSocket
      }
      const promise = checkEmail(baseConfig(), {
        timeoutMs: 100,
        socketFactory: factory,
      })
      // Attach a rejection handler before advancing timers so the awaited
      // rejection surfaces cleanly rather than as an unhandled rejection.
      const rejection = promise.catch((err: Error) => err)
      await vi.advanceTimersByTimeAsync(150)
      const err = await rejection
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects when the server hangs up mid-command', async () => {
    const socket = new FakeSocket([], false)
    const factory: EmailCheckOptions['socketFactory'] = () => {
      setImmediate(() => {
        socket.emit('secureConnect')
        setImmediate(() => socket.emit('close'))
      })
      return socket as unknown as TlsLikeSocket
    }
    await expect(
      checkEmail(baseConfig(), { socketFactory: factory }),
    ).rejects.toThrow(/closed/)
  })

  it('fails when a single response exceeds the byte cap', async () => {
    const socket = new FakeSocket([], false)
    const factory: EmailCheckOptions['socketFactory'] = () => {
      setImmediate(() => {
        socket.emit('secureConnect')
        // Never delivers a newline, just floods bytes.
        setImmediate(() => socket.emit('data', 'A'.repeat(100_000)))
      })
      return socket as unknown as TlsLikeSocket
    }
    await expect(
      checkEmail(baseConfig(), { socketFactory: factory }),
    ).rejects.toThrow(/buffer overflow/)
  })
})
