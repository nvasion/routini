/**
 * SSH Daily Task Service
 *
 * Executes a shell command on a remote host via SSH and returns the output as
 * task logs.  Uses the `ssh2` package under the hood.
 *
 * Configuration (from DailyTask.config — non-secret only):
 *   host        – target SSH hostname or IP (required)
 *   port        – SSH port; default "22"
 *   username    – SSH login name (required)
 *   command     – shell command to run (required)
 *
 * Credentials are read exclusively from environment variables to avoid storing
 * secrets in the task database:
 *   SSH_PRIVATE_KEY       – PEM-encoded private key (preferred)
 *   SSH_KEY_PASSPHRASE    – passphrase for an encrypted private key (optional)
 *   SSH_PASSWORD          – password auth; used only when no private key is set
 *
 * SECURITY:
 *   – Host is first checked synchronously via isSsrfSafeHostname (literal IP
 *     and well-known hostname guard).
 *   – The hostname is then resolved via DNS and the resulting IP is re-checked
 *     against private/loopback ranges (resolvedIpIsSsrfSafe) to mitigate basic
 *     DNS rebinding attacks — consistent with the HTTP service.
 *   – The command field is validated against a blocklist of shell metacharacters
 *     (`;`, `|`, `&`, `` ` ``, `$`, `\`, `>`, `<`, `!`, `{`, `}`, newlines) to
 *     prevent command injection attacks on the remote SSH server.
 *   – Credentials are never included in logs or error messages.
 *   – A configurable read timeout (SSH_CONNECT_TIMEOUT_MS env var, default
 *     10 000 ms) prevents the task from hanging indefinitely.
 */

import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import type { DailyTask } from '../types.js'
import { isSsrfSafeHostname, resolvedIpIsSsrfSafe } from '../utils/network.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SshTaskResult {
  success: boolean
  /** Ordered log lines captured from stdout and stderr. */
  logs: string[]
  /** Human-readable failure reason — never includes credentials. */
  error?: string
}

/** Low-level SSH execution contract used by the real ssh2 adapter and tests. */
export interface SshExecutor {
  exec(config: SshConnectConfig, command: string): Promise<SshExecResult>
}

/** Subset of ssh2's ConnectConfig that the executor receives. */
export interface SshConnectConfig {
  host: string
  port: number
  username: string
  privateKey?: string
  passphrase?: string
  password?: string
  readyTimeout: number
}

export interface SshExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface SshRunnerOptions {
  /**
   * Injectable executor.  The default implementation wraps ssh2.
   * Pass a mock in unit tests to avoid requiring a real SSH daemon.
   */
  executor?: SshExecutor
  /**
   * Override the SSRF DNS-resolution check for testing (avoids real DNS calls).
   * Pass `async () => true` to disable the check in unit tests.
   */
  ssrfCheck?: (hostname: string) => Promise<boolean>
}

// ── Default executor (wraps ssh2) ─────────────────────────────────────────────

class Ssh2Executor implements SshExecutor {
  exec(config: SshConnectConfig, command: string): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      const conn = new Client()
      let stdout = ''
      let stderr = ''
      let settled = false

      function settle(val: SshExecResult | Error): void {
        if (settled) return
        settled = true
        conn.end()
        if (val instanceof Error) reject(val)
        else resolve(val)
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            settle(new Error(`SSH exec error: ${err.message}`))
            return
          }
          stream.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8')
          })
          stream.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8')
          })
          stream.on('close', (code: number | null) => {
            settle({ stdout, stderr, exitCode: code })
          })
          stream.on('error', (err: Error) => {
            settle(new Error(`SSH stream error: ${err.message}`))
          })
        })
      })

      conn.on('error', (err: Error) => {
        // Strip the raw message — it may contain host details that could aid
        // an attacker in fingerprinting the internal network.
        settle(new Error('SSH connection failed'))
      })

      const ssh2Config: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: config.readyTimeout,
        ...(config.privateKey
          ? {
              privateKey: config.privateKey,
              ...(config.passphrase ? { passphrase: config.passphrase } : {}),
            }
          : { password: config.password }),
      }

      conn.connect(ssh2Config)
    })
  }
}

const defaultExecutor = new Ssh2Executor()

// ── Command validation ────────────────────────────────────────────────────────

/**
 * Shell metacharacters that must not appear in SSH commands.
 *
 * Blocked characters and the injection vectors they prevent:
 *   ;        – command separator  (cmd1; cmd2)
 *   |        – pipe               (cmd1 | cmd2)
 *   &        – background / AND   (cmd1 & cmd2, cmd1 && cmd2)
 *   `        – backtick subshell  (`cmd`)
 *   $        – variable/subshell  ($VAR, $(cmd))
 *   \        – escape character   (bypass other guards)
 *   >  <     – I/O redirection    (> /etc/passwd)
 *   !        – history expansion  (!cmd)
 *   {  }     – brace expansion    ({cmd1,cmd2})
 *   \n \r    – newline injection  (multi-command bypass)
 *
 * Characters NOT blocked (safe for common monitoring commands):
 *   alphanumeric, space, - _ / . : @ , + ~ * ? " ' ( ) [ ]
 */
const SSH_COMMAND_FORBIDDEN_CHARS = /[;|&`$\\><!\{\}\n\r]/

/**
 * Checks the command string for forbidden shell metacharacters.
 * Returns an error message if any are found, or null if the command is safe.
 */
function validateSshCommand(command: string): string | null {
  const match = SSH_COMMAND_FORBIDDEN_CHARS.exec(command)
  if (match) {
    return (
      `SSH command contains forbidden shell metacharacter "${match[0]}". ` +
      `Blocked characters: ; | & \` $ \\ > < ! { } and newlines. ` +
      `Use only alphanumeric characters and safe operators (- _ / . : @ , + ~ * ? " ' ( ) [ ]).`
    )
  }
  return null
}

// ── Validation ────────────────────────────────────────────────────────────────

interface SshConfigValidResult {
  valid: true
  host: string
  port: number
  username: string
  command: string
}
interface SshConfigInvalidResult {
  valid: false
  error: string
}
type SshConfigValidation = SshConfigValidResult | SshConfigInvalidResult

function validateSshConfig(config: Record<string, string>): SshConfigValidation {
  const host = config['host']?.trim()
  if (!host) {
    return { valid: false, error: 'SSH task config is missing required field: host' }
  }

  if (!isSsrfSafeHostname(host)) {
    return {
      valid: false,
      error: `SSH host "${host}" is not allowed: private or loopback addresses are blocked`,
    }
  }

  const rawPort = config['port'] ?? '22'
  const port = parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, error: `SSH port "${rawPort}" is not a valid port number` }
  }

  const username = config['username']?.trim()
  if (!username) {
    return { valid: false, error: 'SSH task config is missing required field: username' }
  }

  const command = config['command']?.trim()
  if (!command) {
    return { valid: false, error: 'SSH task config is missing required field: command' }
  }

  const commandError = validateSshCommand(command)
  if (commandError) {
    return { valid: false, error: commandError }
  }

  return { valid: true, host, port, username, command }
}

// ── Service entry point ───────────────────────────────────────────────────────

/**
 * Runs the SSH command specified in `task.config` on the remote host and
 * returns the combined stdout/stderr as log lines plus an overall success flag.
 *
 * @param task     The DailyTask record (must have actionType === 'ssh').
 * @param options  Optional overrides for testing (inject a mock executor).
 */
export async function runSshTask(
  task: DailyTask,
  options: SshRunnerOptions = {},
): Promise<SshTaskResult> {
  const executor = options.executor ?? defaultExecutor
  const ssrfCheck = options.ssrfCheck ?? resolvedIpIsSsrfSafe

  const cfg = validateSshConfig(task.config)
  if (!cfg.valid) {
    return { success: false, logs: [], error: cfg.error }
  }

  const privateKey = process.env['SSH_PRIVATE_KEY']
  const passphrase = process.env['SSH_KEY_PASSPHRASE']
  const password = process.env['SSH_PASSWORD']

  if (!privateKey && !password) {
    return {
      success: false,
      logs: [],
      error: 'No SSH credentials configured. Set SSH_PRIVATE_KEY or SSH_PASSWORD.',
    }
  }

  const logs: string[] = [`Connecting to ${cfg.host}:${cfg.port} as ${cfg.username}…`]

  // ── SSRF guard (DNS-based) ────────────────────────────────────────────────
  // The synchronous isSsrfSafeHostname check in validateSshConfig blocks literal
  // private IPs and well-known loopback names, but a hostname that currently
  // resolves to a public IP could be changed to point at an internal address
  // (DNS rebinding).  Resolve and re-check before opening the connection.
  try {
    const safe = await ssrfCheck(cfg.host)
    if (!safe) {
      return {
        success: false,
        logs,
        error: `SSH host "${cfg.host}" resolved to a private or disallowed address`,
      }
    }
  } catch {
    return {
      success: false,
      logs,
      error: `DNS resolution failed for "${cfg.host}"`,
    }
  }

  const connectTimeoutMs = parseInt(
    process.env['SSH_CONNECT_TIMEOUT_MS'] ?? '10000',
    10,
  )

  const connectConfig: SshConnectConfig = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    readyTimeout: Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0
      ? connectTimeoutMs
      : 10_000,
    ...(privateKey
      ? { privateKey, ...(passphrase ? { passphrase } : {}) }
      : { password }),
  }

  try {
    const result = await executor.exec(connectConfig, cfg.command)

    // Append stdout lines
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trimEnd()
      if (trimmed) logs.push(`[stdout] ${trimmed}`)
    }
    // Append stderr lines
    for (const line of result.stderr.split('\n')) {
      const trimmed = line.trimEnd()
      if (trimmed) logs.push(`[stderr] ${trimmed}`)
    }

    const exitCode = result.exitCode
    logs.push(`Command exited with code ${exitCode ?? 'unknown'}`)

    if (exitCode === 0) {
      return { success: true, logs }
    }

    return {
      success: false,
      logs,
      error: `[task:${task.id}] SSH command failed with exit code ${exitCode ?? 'unknown'}`,
    }
  } catch (err) {
    // Keep the error message generic — raw SSH errors may contain hostname or
    // banner information useful for internal network reconnaissance.
    const msg = err instanceof Error ? err.message : 'Unexpected SSH error'
    logs.push(`Error: ${msg}`)
    return {
      success: false,
      logs,
      error: `[task:${task.id}] ${msg}`,
    }
  }
}
