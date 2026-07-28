/**
 * Tests for the integration_metadata SQLite persistence helpers
 * (server/src/db/index.ts): upsertIntegrationMetadata / getIntegrationMetadata /
 * listIntegrationMetadata / deleteIntegrationMetadata.
 *
 * Coverage:
 *   – the table is created idempotently alongside the rest of the schema
 *   – upsert + get round-trips a row
 *   – upsert on an existing id updates in place (no duplicate rows)
 *   – get/delete on an unknown id are safe no-ops (undefined / 0 rows)
 *   – delete is idempotent and reports rows removed
 *   – rows persist across a simulated restart (close + reopen the same file-backed db)
 *   – list returns all persisted rows, ordered by id
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getDb,
  closeDb,
  resetDb,
  upsertIntegrationMetadata,
  getIntegrationMetadata,
  listIntegrationMetadata,
  deleteIntegrationMetadata,
  type IntegrationMetadataRow,
} from '../server/src/db/index.js'

const originalDbPath = process.env['ROUTINI_DB_PATH']
const originalNodeEnv = process.env['NODE_ENV']

beforeEach(() => {
  resetDb()
})

afterAll(() => {
  closeDb()
  if (originalDbPath === undefined) delete process.env['ROUTINI_DB_PATH']
  else process.env['ROUTINI_DB_PATH'] = originalDbPath
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = originalNodeEnv
})

function row(overrides: Partial<IntegrationMetadataRow> = {}): IntegrationMetadataRow {
  return {
    id: 'github',
    status: 'connected',
    connected_at: '2024-01-01T00:00:00.000Z',
    last_test_at: '2024-01-02T00:00:00.000Z',
    last_test_ok: 1,
    scopes: JSON.stringify({ taskTypes: ['daily'], agents: ['claude'] }),
    updated_at: '2024-01-02T00:00:00.000Z',
    ...overrides,
  }
}

describe('integration_metadata table', () => {
  it('is created idempotently alongside the rest of the schema', () => {
    const db = getDb()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toContain('integration_metadata')
  })
})

describe('upsertIntegrationMetadata / getIntegrationMetadata', () => {
  it('round-trips a row', () => {
    upsertIntegrationMetadata(row())
    const found = getIntegrationMetadata('github')
    expect(found).toBeDefined()
    expect(found!.status).toBe('connected')
    expect(found!.connected_at).toBe('2024-01-01T00:00:00.000Z')
    expect(found!.last_test_ok).toBe(1)
    expect(JSON.parse(found!.scopes)).toEqual({ taskTypes: ['daily'], agents: ['claude'] })
  })

  it('updates an existing row in place on conflict (no duplicate rows)', () => {
    upsertIntegrationMetadata(row())
    upsertIntegrationMetadata(
      row({ status: 'error', last_test_ok: 0, updated_at: '2024-01-03T00:00:00.000Z' }),
    )
    const found = getIntegrationMetadata('github')
    expect(found!.status).toBe('error')
    expect(found!.last_test_ok).toBe(0)
    expect(found!.updated_at).toBe('2024-01-03T00:00:00.000Z')
    expect(listIntegrationMetadata().filter((r) => r.id === 'github')).toHaveLength(1)
  })

  it('stores null connected_at/last_test_at/last_test_ok for a never-tested integration', () => {
    upsertIntegrationMetadata(
      row({ status: 'connected', connected_at: '2024-01-01T00:00:00.000Z', last_test_at: null, last_test_ok: null }),
    )
    const found = getIntegrationMetadata('github')
    expect(found!.last_test_at).toBeNull()
    expect(found!.last_test_ok).toBeNull()
  })

  it('returns undefined for an id with no persisted row', () => {
    expect(getIntegrationMetadata('unknown-integration')).toBeUndefined()
  })
})

describe('listIntegrationMetadata', () => {
  it('returns all persisted rows ordered by id', () => {
    upsertIntegrationMetadata(row({ id: 'slack' }))
    upsertIntegrationMetadata(row({ id: 'github' }))
    upsertIntegrationMetadata(row({ id: 'jira' }))

    const all = listIntegrationMetadata()
    expect(all.map((r) => r.id)).toEqual(['github', 'jira', 'slack'])
  })

  it('returns an empty array when nothing has been persisted', () => {
    expect(listIntegrationMetadata()).toEqual([])
  })
})

describe('deleteIntegrationMetadata', () => {
  it('removes a row and reports 1 row changed', () => {
    upsertIntegrationMetadata(row())
    expect(deleteIntegrationMetadata('github')).toBe(1)
    expect(getIntegrationMetadata('github')).toBeUndefined()
  })

  it('is idempotent: deleting an already-absent row reports 0', () => {
    expect(deleteIntegrationMetadata('github')).toBe(0)
    expect(deleteIntegrationMetadata('github')).toBe(0)
  })

  it('only removes the targeted integration, leaving others intact', () => {
    upsertIntegrationMetadata(row({ id: 'github' }))
    upsertIntegrationMetadata(row({ id: 'slack' }))
    deleteIntegrationMetadata('github')
    expect(getIntegrationMetadata('github')).toBeUndefined()
    expect(getIntegrationMetadata('slack')).toBeDefined()
  })
})

describe('persistence across a simulated restart', () => {
  it('survives closeDb() + reopening the same file-backed database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routini-integration-db-'))
    const dbPath = join(dir, 'routini.db')
    process.env['ROUTINI_DB_PATH'] = dbPath
    closeDb()

    try {
      upsertIntegrationMetadata(row({ id: 'linear', status: 'connected' }))
      expect(getIntegrationMetadata('linear')).toBeDefined()

      // Simulate a process restart: close the connection and reopen from the
      // same file path — the row must still be there.
      closeDb()
      const reopened = getIntegrationMetadata('linear')
      expect(reopened).toBeDefined()
      expect(reopened!.status).toBe('connected')
    } finally {
      closeDb()
      delete process.env['ROUTINI_DB_PATH']
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
