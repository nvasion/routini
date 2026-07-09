/**
 * IMAP daily-task handler.
 *
 * Speaks the minimum subset of RFC 3501 required to satisfy the daily-task
 * PRD line: connect to an IMAP server, authenticate, open a folder, and
 * report how many messages the folder holds plus how many are unread. Any
 * fancier IMAP feature (searches, header parsing, message download) is
 * intentionally out of scope — the point of a *daily* task is a quick
 * signal, not a full mail client.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Security posture
 * ─────────────────────────────────────────────────────────────────────────
 *
 * - **TLS-only.** The default port is 993 (IMAPS) and the transport is
 *   `tls.connect` with `rejectUnauthorized: true`. STARTTLS-on-plaintext is
 *   deliberately not supported: the extra state machine surface introduces
 *   downgrade attacks that aren't worth handling for a status check.
 * - **SSRF guard on host.** Same allowlist as the SSH and HTTP handlers.
 * - **Credentials scrubbed on error.** Any `Error` that escapes has been
 *   passed through `sanitizeError` with the password added to the
 *   `sensitive` set, so an ssh-style "AUTH LOGIN failed: pwd=abc123"
 *   protocol echo can't leak into logs.
 * - **Command literals are IMAP-quoted.** `\` and `"` are escaped inside
 *   quoted-strings so a mailbox name of `foo"bar` cannot inject a second
 *   IMAP command.
 * - **Wall-clock timeout.** A stalled connection or a server that never
 *   completes a response line is torn down at `timeoutMs`.
 * - **Bounded response buffer.** Each response is capped at 64 KiB — an
 *   IMAP untagged response for a single folder should be a few hundred
 *   bytes; a runaway server hitting the cap fails the run rather than
 *   filling the Node heap.
 */

import * as tls from 'node:tls'
import type { EmailConfig } from '../types.js'
import { isSsrfUnsafeHostname } from '../validation.js'
import { sanitizeError } from './sanitizeError.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailCheckResult {
  /** IMAP `EXISTS` — total messages in the folder. */
  totalMessages: number
  /** Unread messages: IMAP `SEARCH UNSEEN` result count. */
  unreadMessages: number
  /** Folder that was checked (echoed for downstream log lines). */
  folder: string
}

export interface EmailCheckOptions {
  timeoutMs?: number
  /** Injected socket factory — tests wire a full-duplex fake. */
  socketFactory?: (host: string, port: number) => TlsLikeSocket
}

/**
 * Minimal duplex interface the handler needs from its transport. The concrete
 * default is `tls.TLSSocket`, but tests supply a small `EventEmitter`-shaped
 * fake so no real TLS handshake is ever attempted in unit tests.
 *
 * The event-listener overloads are intentionally permissive (`on(event, listener)`)
 * so the interface accepts both a real `TLSSocket` (which has narrow per-event
 * overloads on its `on`) and a hand-rolled fake without an event-emitter
 * shape argument type. The handler code is careful to only subscribe to the
 * event names the concrete socket actually emits.
 */
export interface TlsLikeSocket {
  write(data: string): boolean
  end(): void
  destroy(err?: Error): void
  setEncoding(encoding: BufferEncoding): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): this
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_IMAPS_PORT = 993
const MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_FOLDER = 'INBOX'

// ---------------------------------------------------------------------------
// IMAP quoting
// ---------------------------------------------------------------------------

/**
 * Quote an IMAP mailbox / atom argument. RFC 3501 quoted-string: enclose in
 * `"`, escape `\` and `"` with a backslash. Also refuses embedded CR/LF —
 * IMAP quoted strings cannot contain them, and admitting them would allow
 * command injection into a second IMAP command.
 */
function quoteImap(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error('IMAP argument must not contain CR or LF')
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Connect to the configured IMAP server, log in, open `folder` (defaults to
 * INBOX) and return message counts.
 *
 * Errors are always `sanitizeError`-wrapped and prefixed with `imap` so
 * operators can spot handler-level failures without exposing credentials.
 */
export async function checkEmail(
  config: EmailConfig,
  options: EmailCheckOptions = {},
): Promise<EmailCheckResult> {
  const host = config.host?.trim() ?? ''
  const port = config.port ?? DEFAULT_IMAPS_PORT
  const username = config.username?.trim() ?? ''
  const password = config.password ?? ''
  const folder = (config.folder ?? DEFAULT_FOLDER).trim() || DEFAULT_FOLDER
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sensitive = [password]

  if (host.length === 0) {
    throw sanitizeError('host is required', { context: 'imap', sensitive })
  }
  if (isSsrfUnsafeHostname(host)) {
    throw sanitizeError('host targets a disallowed address', {
      context: 'imap',
      sensitive,
    })
  }
  if (username.length === 0) {
    throw sanitizeError('username is required', { context: 'imap', sensitive })
  }
  if (password.length === 0) {
    throw sanitizeError('password is required', { context: 'imap', sensitive })
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw sanitizeError('timeoutMs must be a positive integer', {
      context: 'imap',
      sensitive,
    })
  }
  // IMAP quoting rejects control chars in mailbox names too — quote defensively
  // before we ever send it over the wire.
  let folderQuoted: string
  try {
    folderQuoted = quoteImap(folder)
  } catch (err) {
    throw sanitizeError(err, { context: 'imap folder', sensitive })
  }
  let usernameQuoted: string
  let passwordQuoted: string
  try {
    usernameQuoted = quoteImap(username)
    passwordQuoted = quoteImap(password)
  } catch (err) {
    throw sanitizeError(err, { context: 'imap credentials', sensitive })
  }

  const factory =
    options.socketFactory ??
    ((h: string, p: number): TlsLikeSocket =>
      tls.connect({
        host: h,
        port: p,
        // Require a valid certificate chain. Do not permit users to override:
        // an IMAP task hitting a self-signed prod server should be caught, not
        // silently ignored.
        rejectUnauthorized: true,
        servername: h,
      }) as unknown as TlsLikeSocket)

  const socket = factory(host, port)
  socket.setEncoding('utf8')

  return new Promise<EmailCheckResult>((resolve, reject) => {
    let settled = false
    let buffer = ''
    let currentResolver: ((line: string[]) => void) | null = null
    let currentRejector: ((err: Error) => void) | null = null
    let currentTag: string | null = null
    let currentLines: string[] = []
    let tagCounter = 0

    const timer = setTimeout(() => {
      fail(new Error(`timed out after ${timeoutMs}ms`), 'timeout')
    }, timeoutMs)

    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.end()
      } catch {
        // ignore — best-effort close
      }
      fn()
    }

    function fail(err: unknown, suffix: string): void {
      settle(() =>
        reject(sanitizeError(err, { context: `imap ${suffix}`, sensitive })),
      )
    }

    function nextTag(): string {
      tagCounter += 1
      return `A${tagCounter.toString().padStart(4, '0')}`
    }

    /**
     * Send a command tagged with `tag` and wait for its final tagged
     * response line. Untagged responses ("* …") are buffered and delivered
     * as part of the resolution.
     */
    function send(command: string): Promise<string[]> {
      return new Promise<string[]>((res, rej) => {
        const tag = nextTag()
        currentTag = tag
        currentLines = []
        currentResolver = res
        currentRejector = rej
        socket.write(`${tag} ${command}\r\n`)
      })
    }

    function handleLine(line: string): void {
      if (!currentTag || !currentResolver || !currentRejector) {
        // Server greeting or unsolicited untagged before we send a command.
        return
      }
      if (line.startsWith(`${currentTag} `)) {
        const status = line.slice(currentTag.length + 1).split(' ', 1)[0]
        const lines = [...currentLines, line]
        const resolver = currentResolver
        const rejector = currentRejector
        currentTag = null
        currentLines = []
        currentResolver = null
        currentRejector = null
        if (status === 'OK') {
          resolver(lines)
        } else {
          // Do NOT echo the server's tail (may contain literal error text
          // that reflects credentials on some servers).
          rejector(new Error(`server responded ${status}`))
        }
        return
      }
      // Untagged / continuation response; buffer for the caller.
      currentLines.push(line)
    }

    socket.on('data', (chunk: string) => {
      if (settled) return
      buffer += chunk
      if (buffer.length > MAX_RESPONSE_BYTES) {
        fail(new Error('response exceeded byte cap'), 'buffer overflow')
        return
      }
      let newlineIdx = buffer.indexOf('\r\n')
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 2)
        try {
          handleLine(line)
        } catch (err) {
          fail(err, 'response parse')
          return
        }
        newlineIdx = buffer.indexOf('\r\n')
      }
    })

    socket.on('error', (err: Error) => fail(err, 'socket error'))
    socket.on('close', () => {
      if (!settled) fail(new Error('connection closed unexpectedly'), 'closed')
    })

    const ready = async (): Promise<void> => {
      try {
        // 1) LOGIN — a bare `LOGIN` command sends username and password.
        //    Both are quoted IMAP strings so a `"` in a mailbox / username
        //    cannot escape the argument context.
        await send(`LOGIN ${usernameQuoted} ${passwordQuoted}`)

        // 2) EXAMINE — read-only SELECT. We choose EXAMINE deliberately: the
        //    daily task must not mutate mailbox state (no /Seen flag changes,
        //    no cursor advance), which SELECT would do.
        const examineLines = await send(`EXAMINE ${folderQuoted}`)
        const totalMessages = parseExists(examineLines)

        // 3) SEARCH UNSEEN — count of unread messages.
        const searchLines = await send('SEARCH UNSEEN')
        const unreadMessages = parseSearch(searchLines)

        // 4) LOGOUT — graceful shutdown.
        try {
          await send('LOGOUT')
        } catch {
          // Some servers close the socket before the OK; don't fail the run
          // on the shutdown itself.
        }

        settle(() => resolve({ totalMessages, unreadMessages, folder }))
      } catch (err) {
        fail(err, 'command failed')
      }
    }

    // Node's TLSSocket emits 'secureConnect', a raw net Socket 'connect'.
    socket.once('secureConnect', () => {
      void ready()
    })
    socket.once('connect', () => {
      void ready()
    })
  })
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/** Extract `<N>` from the first line matching `* <N> EXISTS`. */
function parseExists(lines: readonly string[]): number {
  for (const line of lines) {
    const match = /^\* (\d+) EXISTS\b/i.exec(line)
    if (match) return Number(match[1])
  }
  return 0
}

/** Parse an untagged `* SEARCH …` response into a message-number count. */
function parseSearch(lines: readonly string[]): number {
  for (const line of lines) {
    const match = /^\* SEARCH(.*)$/i.exec(line)
    if (match) {
      const rest = match[1].trim()
      if (rest.length === 0) return 0
      return rest.split(/\s+/).filter((t) => /^\d+$/.test(t)).length
    }
  }
  return 0
}
