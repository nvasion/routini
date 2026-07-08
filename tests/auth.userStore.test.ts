import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserStore } from '../server/src/auth/userStore.js'

describe('UserStore', () => {
  it('creates a user and finds them by id', async () => {
    const store = new UserStore()
    const created = await store.createUser('Alice', 'p@ss')
    expect(created.username).toBe('alice')
    const found = store.findById(created.id)
    expect(found?.username).toBe('alice')
  })

  it('normalizes usernames on creation and lookup', async () => {
    const store = new UserStore()
    await store.createUser('  Bob  ', 'pw')
    const user = await store.verifyCredentials('BOB', 'pw')
    expect(user?.username).toBe('bob')
  })

  it('rejects duplicate usernames', async () => {
    const store = new UserStore()
    await store.createUser('charlie', 'pw')
    await expect(store.createUser('Charlie', 'pw2')).rejects.toThrow(/already exists/)
  })

  it('returns null for unknown user or wrong password', async () => {
    const store = new UserStore()
    await store.createUser('dave', 'right')
    expect(await store.verifyCredentials('dave', 'wrong')).toBeNull()
    expect(await store.verifyCredentials('nobody', 'right')).toBeNull()
  })

  it('returns null for non-string credentials rather than throwing', async () => {
    const store = new UserStore()
    await store.createUser('erin', 'pw')
    expect(await store.verifyCredentials(undefined, 'pw')).toBeNull()
    expect(await store.verifyCredentials('erin', 42)).toBeNull()
  })

  it('rejects invalid usernames on creation', async () => {
    const store = new UserStore()
    await expect(store.createUser('', 'pw')).rejects.toThrow(/empty/)
    await expect(store.createUser('x'.repeat(65), 'pw')).rejects.toThrow(/64/)
  })

  describe('session tracking', () => {
    it('registers and revokes sessions', async () => {
      const store = new UserStore()
      const user = await store.createUser('frank', 'pw')
      expect(await store.registerSession(user.id, 'sess-1')).toBe(true)
      expect(store.isSessionActive(user.id, 'sess-1')).toBe(true)
      expect(await store.revokeSession(user.id, 'sess-1')).toBe(true)
      expect(store.isSessionActive(user.id, 'sess-1')).toBe(false)
    })

    it('returns false for missing users / empty session ids', async () => {
      const store = new UserStore()
      expect(await store.registerSession('no-such-user', 'sess')).toBe(false)
      expect(await store.revokeSession('no-such-user', 'sess')).toBe(false)
      expect(store.isSessionActive('', 'sess')).toBe(false)
      const user = await store.createUser('grace', 'pw')
      expect(await store.registerSession(user.id, '')).toBe(false)
    })

    it('is idempotent — registering the same id twice is fine', async () => {
      const store = new UserStore()
      const user = await store.createUser('heidi', 'pw')
      await store.registerSession(user.id, 'sess-1')
      await store.registerSession(user.id, 'sess-1')
      expect(store.isSessionActive(user.id, 'sess-1')).toBe(true)
      // Revoking once is enough — the second call reports no-op.
      expect(await store.revokeSession(user.id, 'sess-1')).toBe(true)
      expect(await store.revokeSession(user.id, 'sess-1')).toBe(false)
    })

    it('caps the number of active sessions per user', async () => {
      const store = new UserStore()
      const user = await store.createUser('ivan', 'pw')
      // Cap is 10 — the earliest session should get evicted when we exceed it.
      for (let i = 0; i < 11; i += 1) {
        await store.registerSession(user.id, `sess-${i}`)
      }
      expect(store.isSessionActive(user.id, 'sess-0')).toBe(false)
      expect(store.isSessionActive(user.id, 'sess-10')).toBe(true)
    })
  })

  describe('file persistence', () => {
    let tmpDir: string
    let storePath: string

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'routini-userstore-'))
      storePath = join(tmpDir, 'users.json')
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    it('requires an absolute path when a filePath is given', () => {
      expect(() => new UserStore({ filePath: 'relative.json' })).toThrow(/absolute/)
      expect(() => new UserStore({ filePath: '' })).toThrow(/non-empty/)
    })

    it('persists users across load() cycles', async () => {
      const first = new UserStore({ filePath: storePath })
      await first.load() // no file yet, silent no-op
      const user = await first.createUser('jane', 'pw')
      await first.registerSession(user.id, 'sess-1')

      const second = new UserStore({ filePath: storePath })
      await second.load()
      const reloaded = second.findById(user.id)
      expect(reloaded?.username).toBe('jane')
      expect(second.isSessionActive(user.id, 'sess-1')).toBe(true)
      expect(await second.verifyCredentials('jane', 'pw')).not.toBeNull()
    })

    it('writes the persistence file with restrictive permissions and creates parent dirs', async () => {
      const nested = join(tmpDir, 'sub', 'dir', 'users.json')
      const store = new UserStore({ filePath: nested })
      await store.load()
      await store.createUser('kate', 'pw')
      const raw = await readFile(nested, 'utf8')
      const parsed = JSON.parse(raw) as { version: number; users: unknown[] }
      expect(parsed.version).toBe(1)
      expect(Array.isArray(parsed.users)).toBe(true)
    })

    it('surfaces a helpful error when the store file is malformed', async () => {
      await writeFile(storePath, 'not-json', 'utf8')
      const store = new UserStore({ filePath: storePath })
      await expect(store.load()).rejects.toThrow(/not valid JSON/)
    })

    it('rejects an unsupported store version instead of silently starting fresh', async () => {
      await writeFile(storePath, JSON.stringify({ version: 99, users: [] }), 'utf8')
      const store = new UserStore({ filePath: storePath })
      await expect(store.load()).rejects.toThrow(/unsupported version/)
    })
  })
})
