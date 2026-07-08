import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { hashPassword, verifyPassword } from './passwords.js'

export interface User {
  id: string
  username: string
  createdAt: string
}

interface StoredUser extends User {
  passwordHash: string
  /**
   * Set of currently-valid session ids (jti claims). Tokens whose jti is not
   * in this set are treated as revoked — this is how logout invalidates a
   * stolen JWT server-side.
   */
  activeSessions: string[]
}

interface StoreFile {
  version: 1
  users: StoredUser[]
}

const CURRENT_STORE_VERSION = 1
const MAX_ACTIVE_SESSIONS_PER_USER = 10
const MAX_USERNAME_LENGTH = 64
const MAX_STORE_FILE_BYTES = 5 * 1024 * 1024 // 5 MiB safety cap on the on-disk file

/**
 * Configuration for the user store. When `filePath` is set, the store loads
 * and persists state to that file so users survive server restarts (addressing
 * the reliability concern raised in review). When omitted, the store operates
 * purely in-memory — appropriate for tests and short-lived dev processes.
 */
export interface UserStoreOptions {
  /**
   * Absolute path to the JSON file that backs the store. Must be an absolute
   * path to avoid ambiguity with the process CWD.
   */
  filePath?: string
}

/**
 * User store with optional JSON-file persistence.
 *
 * Persistence uses an atomic write (tmp file + rename) so a crash during a
 * write cannot corrupt the on-disk file. All mutation methods serialize via
 * an internal write queue — a subsequent write is chained after any in-flight
 * write, guaranteeing writes are applied in order without interleaving.
 */
export class UserStore {
  private readonly users = new Map<string, StoredUser>()
  private readonly filePath: string | null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: UserStoreOptions = {}) {
    if (options.filePath !== undefined) {
      if (typeof options.filePath !== 'string' || options.filePath.length === 0) {
        throw new Error('UserStore filePath must be a non-empty string when provided')
      }
      if (!isAbsolute(options.filePath)) {
        throw new Error('UserStore filePath must be an absolute path')
      }
      // Resolve to normalize away `..` segments — the operator supplied the
      // path but we still want a canonical form for error messages and I/O.
      this.filePath = resolve(options.filePath)
    } else {
      this.filePath = null
    }
  }

  /**
   * Load persisted users from disk. Safe to call when no file exists yet
   * (returns without error). Throws if the file exists but is unreadable or
   * malformed — the operator should notice rather than silently start fresh.
   */
  async load(): Promise<void> {
    if (!this.filePath) return
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw wrapError(err, `failed to read user store at ${this.filePath}`)
    }
    if (raw.length > MAX_STORE_FILE_BYTES) {
      throw new Error(
        `user store file at ${this.filePath} is too large (${raw.length} bytes)`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw wrapError(err, `user store at ${this.filePath} is not valid JSON`)
    }
    const file = parseStoreFile(parsed)
    this.users.clear()
    for (const record of file.users) {
      this.users.set(record.username, record)
    }
  }

  async createUser(username: string, password: string): Promise<User> {
    const normalized = normalizeUsername(username)
    if (this.users.has(normalized)) {
      throw new Error(`user ${normalized} already exists`)
    }
    const passwordHash = await hashPassword(password)
    const record: StoredUser = {
      id: randomUUID(),
      username: normalized,
      passwordHash,
      createdAt: new Date().toISOString(),
      activeSessions: [],
    }
    this.users.set(normalized, record)
    await this.persist()
    return toPublicUser(record)
  }

  async verifyCredentials(username: unknown, password: unknown): Promise<User | null> {
    if (typeof username !== 'string' || typeof password !== 'string') {
      return null
    }
    // A malformed username (empty, too long, etc.) should behave the same as
    // "unknown user" so the caller can respond with a single 401 message. Any
    // other error still propagates for the route handler to log.
    let normalized: string
    try {
      normalized = normalizeUsername(username)
    } catch {
      return null
    }
    const record = this.users.get(normalized)
    if (!record) {
      return null
    }
    const ok = await verifyPassword(password, record.passwordHash)
    return ok ? toPublicUser(record) : null
  }

  findById(id: string): User | null {
    const record = this.findRecordById(id)
    return record ? toPublicUser(record) : null
  }

  /**
   * Register a new session id for a user. Returns false if the user does not
   * exist (defensive — should not happen since callers just verified them).
   * Older sessions are evicted once the per-user cap is reached to bound
   * memory growth from clients that never explicitly log out.
   *
   * Eviction is **FIFO by registration order**: `activeSessions` is an array
   * where the newest id is pushed to the tail, so when the length exceeds
   * `MAX_ACTIVE_SESSIONS_PER_USER` we slice off the head. Re-registering an
   * existing id also moves it to the tail, so an active client that keeps
   * logging in and out won't be pushed out by their own repeated logins.
   * We chose FIFO over LRU deliberately — session validity is a signature
   * check, not a hot-path read, so LRU accounting would add complexity for
   * no measurable benefit.
   */
  async registerSession(userId: string, sessionId: string): Promise<boolean> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const record = this.findRecordById(userId)
    if (!record) return false
    // Drop duplicates (idempotent registration) and cap the list.
    const next = record.activeSessions.filter((id) => id !== sessionId)
    next.push(sessionId)
    if (next.length > MAX_ACTIVE_SESSIONS_PER_USER) {
      next.splice(0, next.length - MAX_ACTIVE_SESSIONS_PER_USER)
    }
    record.activeSessions = next
    await this.persist()
    return true
  }

  /**
   * Invalidate a session id. Returns true when the session existed and was
   * removed. Callers should treat "not found" as already-logged-out.
   */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const record = this.findRecordById(userId)
    if (!record) return false
    const before = record.activeSessions.length
    record.activeSessions = record.activeSessions.filter((id) => id !== sessionId)
    if (record.activeSessions.length === before) return false
    await this.persist()
    return true
  }

  /** True when the session id is currently valid for the user. */
  isSessionActive(userId: string, sessionId: string): boolean {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const record = this.findRecordById(userId)
    if (!record) return false
    return record.activeSessions.includes(sessionId)
  }

  /** Test / seed helper — exposed for wiring the default admin. */
  size(): number {
    return this.users.size
  }

  private findRecordById(id: string): StoredUser | null {
    if (typeof id !== 'string' || id.length === 0) return null
    for (const record of this.users.values()) {
      if (record.id === id) return record
    }
    return null
  }

  private persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve()
    // Chain writes so concurrent calls serialize; if one fails we still let
    // subsequent writes run against the latest in-memory state.
    const filePath = this.filePath
    const snapshot = this.snapshot()
    const next = this.writeChain.then(
      () => writeAtomic(filePath, snapshot),
      () => writeAtomic(filePath, snapshot),
    )
    this.writeChain = next.catch(() => {
      /* swallow rejection so a failure doesn't poison the chain */
    })
    return next
  }

  private snapshot(): string {
    const file: StoreFile = {
      version: CURRENT_STORE_VERSION,
      users: [...this.users.values()].map((record) => ({
        id: record.id,
        username: record.username,
        createdAt: record.createdAt,
        passwordHash: record.passwordHash,
        activeSessions: [...record.activeSessions],
      })),
    }
    return JSON.stringify(file, null, 2)
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const dir = dirname(filePath)
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    throw wrapError(err, `failed to create user store directory ${dir}`)
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    // 0o600 → owner-only; the file contains password hashes and session ids.
    await writeFile(tmpPath, contents, { mode: 0o600 })
    await rename(tmpPath, filePath)
  } catch (err) {
    throw wrapError(err, `failed to persist user store to ${filePath}`)
  }
}

function normalizeUsername(username: string): string {
  if (typeof username !== 'string') {
    throw new Error('username must be a string')
  }
  const trimmed = username.trim().toLowerCase()
  if (trimmed.length === 0) {
    throw new Error('username must not be empty')
  }
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    throw new Error(`username must be ${MAX_USERNAME_LENGTH} characters or fewer`)
  }
  return trimmed
}

/**
 * Best-effort username normalization for callers that need a bucketing key
 * (e.g. the login rate limiter) rather than a validated lookup. Non-string
 * or empty inputs collapse to an empty string instead of throwing, since the
 * caller is downstream of a request that may not have supplied a username.
 *
 * Kept next to `normalizeUsername` so both use the same casing/whitespace
 * rules — an attacker can't dodge one by exploiting a mismatch with the
 * other.
 */
export function normalizeUsernameForKeying(username: unknown): string {
  if (typeof username !== 'string') return ''
  const trimmed = username.trim().toLowerCase()
  if (trimmed.length === 0) return ''
  return trimmed.slice(0, MAX_USERNAME_LENGTH)
}

function toPublicUser(record: StoredUser): User {
  return {
    id: record.id,
    username: record.username,
    createdAt: record.createdAt,
  }
}

function parseStoreFile(value: unknown): StoreFile {
  if (!value || typeof value !== 'object') {
    throw new Error('user store file is not an object')
  }
  const obj = value as Record<string, unknown>
  if (obj.version !== CURRENT_STORE_VERSION) {
    throw new Error(`user store file has unsupported version ${String(obj.version)}`)
  }
  if (!Array.isArray(obj.users)) {
    throw new Error('user store file is missing users array')
  }
  const users: StoredUser[] = []
  for (const raw of obj.users) {
    users.push(parseStoredUser(raw))
  }
  return { version: CURRENT_STORE_VERSION, users }
}

function parseStoredUser(value: unknown): StoredUser {
  if (!value || typeof value !== 'object') {
    throw new Error('user record is not an object')
  }
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.length === 0) {
    throw new Error('user record is missing id')
  }
  if (typeof v.username !== 'string' || v.username.length === 0) {
    throw new Error('user record is missing username')
  }
  if (typeof v.passwordHash !== 'string' || v.passwordHash.length === 0) {
    throw new Error('user record is missing passwordHash')
  }
  if (typeof v.createdAt !== 'string' || v.createdAt.length === 0) {
    throw new Error('user record is missing createdAt')
  }
  const sessions = Array.isArray(v.activeSessions)
    ? v.activeSessions.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  return {
    id: v.id,
    username: v.username,
    passwordHash: v.passwordHash,
    createdAt: v.createdAt,
    activeSessions: sessions.slice(-MAX_ACTIVE_SESSIONS_PER_USER),
  }
}

function wrapError(err: unknown, message: string): Error {
  const cause = err instanceof Error ? err : new Error(String(err))
  const wrapped = new Error(`${message}: ${cause.message}`)
  ;(wrapped as Error & { cause?: unknown }).cause = cause
  return wrapped
}
