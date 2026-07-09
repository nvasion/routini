/**
 * SSH daily-task handler.
 *
 * Connects to a remote host with `ssh2`, executes a single command, and
 * returns the exit code, truncated stdout, and truncated stderr. The handler
 * NEVER logs the raw command output or credential material — its `run`
 * method returns a structured result, and any error thrown out of it has
 * been passed through `sanitizeError` so passwords and PEM key material
 * cannot appear in server logs or in the task-run error field.
 *
 * Non-goals: this module does not stream long-running command output back
 * to the caller. The daily-task PRD line calls for "SSH commands" as short
 * automations (health checks, deploy triggers) — long-running interactive
 * sessions belong to a future feature.
 */

import { Client, type ConnectConfig } from 'ssh2'
import type { SshConfig } from '../types.js'
import { isSsrfUnsafeHostname } from '../validation.js'
import { sanitizeError } from './sanitizeError.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SshRunResult {
  /** Remote process exit code. `null` when the remote side reported a signal instead. */
  exitCode: number | null
  /** Signal name if the remote process was killed by a signal. */
  signal: string | null
  /** UTF-8 decoded stdout, truncated to `maxOutputBytes`. */
  stdout: string
  /** UTF-8 decoded stderr, truncated to `maxOutputBytes`. */
  stderr: string
  /** True when stdout was cut short at the byte cap. */
  stdoutTruncated: boolean
  /** True when stderr was cut short at the byte cap. */
  stderrTruncated: boolean
}

export interface SshRunOptions {
  /** Overall wall-clock deadline for the whole run (connect + auth + exec). */
  timeoutMs?: number
  /** Per-stream output cap, applied to stdout and stderr independently. */
  maxOutputBytes?: number
  /**
   * Injectable client factory — tests supply a fake Client. Defaults to
   * `() => new Client()` at call time so a real ssh2 Client is only ever
   * instantiated when the handler actually runs.
   */
  clientFactory?: () => Client
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
/** 1 MiB stdout/stderr cap — plenty for the daily "run a health check" workload. */
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_SSH_PORT = 22

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a command on the configured SSH host and return the result.
 *
 * The handler enforces:
 *   1. Host is not in an SSRF-unsafe range (belt-and-braces on top of the
 *      validation-time check).
 *   2. Either `password` or `privateKey` must be present — never both are
 *      required, but at least one credential must exist.
 *   3. Wall-clock timeout via a top-level `setTimeout` that hard-closes the
 *      client and rejects the promise, so a stalled TCP/SSH handshake can't
 *      hold up the executor indefinitely.
 *   4. Output caps applied per-stream so a runaway command can't fill the
 *      Node process heap with buffered stdout.
 *
 * Any error thrown out of this function is safe to log or persist: raw
 * credentials have been stripped and the message is prefixed with
 * `"ssh: …"` so downstream operators can trace the origin.
 */
export async function runSsh(
  config: SshConfig,
  options: SshRunOptions = {},
): Promise<SshRunResult> {
  const host = config.host?.trim() ?? ''
  const port = config.port ?? DEFAULT_SSH_PORT
  const username = config.username?.trim() ?? ''
  const command = config.command ?? ''
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const clientFactory = options.clientFactory ?? (() => new Client())

  // Collected here so `sanitizeError` can scrub them from any thrown message,
  // including messages generated deep inside ssh2 that we don't control.
  const sensitive = [config.password, config.privateKey]

  if (host.length === 0) {
    throw sanitizeError('host is required', { context: 'ssh', sensitive })
  }
  if (isSsrfUnsafeHostname(host)) {
    // Even though validation catches this earlier, re-check here so the
    // handler is safe when called from tests or a future scheduler that
    // bypasses the HTTP validation layer.
    throw sanitizeError('host targets a disallowed address', {
      context: 'ssh',
      sensitive,
    })
  }
  if (username.length === 0) {
    throw sanitizeError('username is required', { context: 'ssh', sensitive })
  }
  if (command.trim().length === 0) {
    throw sanitizeError('command is required', { context: 'ssh', sensitive })
  }
  if (!config.password && !config.privateKey) {
    throw sanitizeError(
      'either password or privateKey must be provided',
      { context: 'ssh', sensitive },
    )
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw sanitizeError('timeoutMs must be a positive integer', {
      context: 'ssh',
      sensitive,
    })
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw sanitizeError('maxOutputBytes must be a positive integer', {
      context: 'ssh',
      sensitive,
    })
  }

  const connectConfig: ConnectConfig = {
    host,
    port,
    username,
    // ssh2's per-handshake timeout — a second belt around the outer timeout.
    readyTimeout: timeoutMs,
    // Disable keyboard-interactive fallback so a mis-configured server can't
    // silently escalate a password prompt cycle.
    tryKeyboard: false,
    ...(config.password ? { password: config.password } : {}),
    ...(config.privateKey ? { privateKey: config.privateKey } : {}),
  }

  const client = clientFactory()

  return new Promise<SshRunResult>((resolve, reject) => {
    let settled = false
    let timeoutHandle: NodeJS.Timeout | null = null

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      try {
        client.end()
      } catch {
        // ssh2's Client.end() can throw when called on a socket that
        // errored during connect. Swallow — we're already tearing down.
      }
      fn()
    }

    const fail = (err: unknown, contextSuffix: string): void => {
      settle(() =>
        reject(
          sanitizeError(err, {
            context: `ssh ${contextSuffix}`,
            sensitive,
          }),
        ),
      )
    }

    timeoutHandle = setTimeout(() => {
      fail(new Error(`timed out after ${timeoutMs}ms`), 'timeout')
    }, timeoutMs)

    client.on('error', (err) => fail(err, 'connection error'))
    // 'close' fires after a normal `end()` too — only treat it as a failure
    // when we haven't already resolved.
    client.on('close', () => {
      if (!settled) fail(new Error('connection closed unexpectedly'), 'closed')
    })

    client.on('ready', () => {
      client.exec(command, (err, stream) => {
        if (err) {
          fail(err, 'exec failed')
          return
        }

        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let stdoutTruncated = false
        let stderrTruncated = false
        let exitCode: number | null = null
        let signal: string | null = null

        const capture = (
          chunk: Buffer,
          chunks: Buffer[],
          bytesRef: 'stdout' | 'stderr',
        ): void => {
          if (bytesRef === 'stdout') {
            if (stdoutBytes >= maxOutputBytes) {
              stdoutTruncated = true
              return
            }
            const room = maxOutputBytes - stdoutBytes
            if (chunk.length > room) {
              chunks.push(chunk.subarray(0, room))
              stdoutBytes = maxOutputBytes
              stdoutTruncated = true
            } else {
              chunks.push(chunk)
              stdoutBytes += chunk.length
            }
          } else {
            if (stderrBytes >= maxOutputBytes) {
              stderrTruncated = true
              return
            }
            const room = maxOutputBytes - stderrBytes
            if (chunk.length > room) {
              chunks.push(chunk.subarray(0, room))
              stderrBytes = maxOutputBytes
              stderrTruncated = true
            } else {
              chunks.push(chunk)
              stderrBytes += chunk.length
            }
          }
        }

        stream.on('data', (chunk: Buffer) => capture(chunk, stdoutChunks, 'stdout'))
        stream.stderr.on('data', (chunk: Buffer) =>
          capture(chunk, stderrChunks, 'stderr'),
        )

        stream.on('close', (code: number | null, sig: string | null) => {
          exitCode = code
          signal = sig ?? null
          settle(() =>
            resolve({
              exitCode,
              signal,
              stdout: Buffer.concat(stdoutChunks).toString('utf8'),
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
              stdoutTruncated,
              stderrTruncated,
            }),
          )
        })

        stream.on('error', (streamErr: Error) => fail(streamErr, 'stream error'))
      })
    })

    try {
      client.connect(connectConfig)
    } catch (err) {
      fail(err, 'connect threw')
    }
  })
}
