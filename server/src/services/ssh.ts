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
 * Credentials are resolved in priority order: the encrypted credential store
 * first (see server/src/services/credentialStore.ts), falling back to
 * environment variables when nothing is stored.  The store is loaded lazily
 * and is optional — when it is unavailable (e.g. not yet initialised, or in
 * unit tests that only exercise env-var credentials) resolution degrades
 * gracefully to environment variables, preserving the original behaviour.
 * This keeps secrets out of the task database while preserving the original
 * env-var behaviour as a default:
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

/**
 * Resolves a single credential value by name.
 *
 * Implementations MUST check the encrypted credential store first and fall
 * back to environment variables only when nothing is stored under `name`.
 * Returning `undefined` (not the empty string) signals "not configured".
 *
 * Resolving every secret through this single function keeps the lookup order
 * (store-first → env-var fallback) consistent across all SSH credentials.
 */
export interface SshCredentialProvider {
  get(name: string): Promise<string | undefined>
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
  /**
   * Injectable credential resolver.  The default implementation checks the
   * encrypted credential store first and falls back to environment variables.
   * Pass a mock in unit tests to control the credential store without a DB.
   */
  credentialProvider?: SshCredentialProvider
}

// ── Default credential provider (store-first → env-var fallback) ────────────

/**
 * Minimal shape of the encrypted credential store module this service relies
 * on.  Defined locally (rather than via `typeof import(...)`) so that this
 * service type-checks and compiles even before the credential store module
 * exists in the working tree — the store is an optional, lazily-loaded
 * dependency.  The real module in `server/src/services/credentialStore.ts`
 * is expected to export a `getCredential` function matching this contract.
 */
interface CredentialStoreModule {
  /**
   * Retrieves a decrypted secret by name, or `null`/`undefined` when nothing
   * is stored under `name`.  The returned value is the plaintext credential.
   */
  getCredential(name: string): Promise<string | null | undefined>
}

/**
 * Cached handle to the encrypted credential store module.
 *
 * The store is imported lazily so that this service remains usable (falling
 * back to environment variables) even when the store module has not been
 * initialised for the current process — e.g. in unit tests that only exercise
 * env-var credentials.  The import is attempted once and the outcome is
 * cached; subsequent lookups reuse the result without re-importing.
 *
 *   `undefined` – load not yet attempted
 *   `null`      – load attempted but the store is unavailable
 *   object      – the loaded credential store module
 */
let credentialStoreModule: CredentialStoreModule | null | undefined
let credentialStoreLoadAttempted = false

/**
 * Lazily loads the encrypted credential store module, if available.
 * Returns `null` when the module is absent or fails to load — callers MUST
 * treat `null` as "store unavailable" and fall back to environment variables
 * rather than throwing.  A failure is logged once (server-side only) for
 * diagnostics but never surfaces to callers, keeping this resolution path
 * resilient.
 */
async function loadCredentialStore(): Promise<CredentialStoreModule | null> {
  if (credentialStoreLoadAttempted) return credentialStoreModule ?? null
  credentialStoreLoadAttempted = true
  try {
    // Dynamic import keeps this optional: the service compiles and runs even
    // before the credential store module exists in the working tree.  The
    // module specifier is relative so it resolves within the project only.
    // It is held in a variable so the import is resolved at runtime rather
    // than statically by the compiler — the store is an optional dependency.
    const specifier = './credentialStore.js'
    const mod = (await import(specifier)) as Partial<CredentialStoreModule>
    if (mod && typeof mod.getCredential === 'function') {
      credentialStoreModule = mod as CredentialStoreModule
    } else {
      // Module present but does not expose the expected API — treat as
      // unavailable and fall back to environment variables.
      console.warn('[ssh] Credential store module present but missing getCredential export')
      credentialStoreModule = null
    }
  } catch (err) {
    // Store not available (module missing or not yet initialised).  This is
    // a soft failure — fall back to environment variables.  Log server-side
    // only; never include credential material in the message.
    console.warn(
      '[ssh] Credential store unavailable — falling back to environment variables:',
      err instanceof Error ? err.message : 'unknown error',
    )
    credentialStoreModule = null
  }
  return credentialStoreModule
}

/**
 * Default credential resolver.
 *
 * Lookup order:
 *   1. Encrypted credential store (if available) — checked first so that
 *      secrets saved through the credentials API take precedence over
 *      process environment variables.
 *   2. `process.env[name]` — the original source of SSH credentials, kept as
 *      a fallback so existing deployments that configure secrets via env
 *      vars continue to work unchanged.
 *
 * Returns `undefined` when neither source has a value, signalling that the
 * credential is not configured.  Empty-string store values are treated as
 * "not set" so a blank stored secret never shadows a real env-var value.
 */
const defaultCredentialProvider: SshCredentialProvider = {
  async get(name: string): Promise<string | undefined> {
    const store = await loadCredentialStore()
    if (store) {
      try {
        const stored = await store.getCredential(name)
        if (stored && stored.trim() !== '') {
          return stored
        }
      } catch (err) {
        // A store read failure is non-fatal: fall through to the env-var
        // fallback so a transient DB/decryption issue does not break SSH
        // tasks that could otherwise run with env-based credentials.
        console.warn(
          `[ssh] Credential store read failed for "${name}" — falling back to env var:`,
          err instanceof Error ? err.message : 'unknown error',
        )
      }
    }
    const envValue = process.env[name]
    return envValue && envValue.trim() !== '' ? envValue : undefined
  },
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
  const credentialProvider = options.credentialProvider ?? defaultCredentialProvider

  const cfg = validateSshConfig(task.config)
  if (!cfg.valid) {
    return { success: false, logs: [], error: cfg.error }
  }

  // Resolve credentials through the credential provider, which checks the
  // encrypted credential store first and falls back to environment variables.
  // The private key is preferred over the password when both are available.
  // Provider errors are wrapped into a clean failure result so a transient
  // store/decryption failure never crashes the task runner — preserving the
  // documented { success, logs, error } response shape.  Credential material
  // is never included in the surfaced error message.
  let privateKey: string | undefined
  let passphrase: string | undefined
  let password: string | undefined
  try {
    privateKey = await credentialProvider.get('SSH_PRIVATE_KEY')
    passphrase = await credentialProvider.get('SSH_KEY_PASSPHRASE')
    password = await credentialProvider.get('SSH_PASSWORD')
  } catch (err) {
    console.warn(
      '[ssh] Credential resolution failed:',
      err instanceof Error ? err.message : 'unknown error',
    )
    return {
      success: false,
      logs: [],
      error: 'Failed to resolve SSH credentials. Check the credential store configuration.',
    }
  }

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
