/**
 * Wire contract test — enforces that `server/src/tasks/wireEvents.ts` and
 * `client/src/hooks/taskEventWire.ts` stay byte-for-byte identical inside
 * the `WIRE-EVENTS:BEGIN` / `WIRE-EVENTS:END` markers.
 *
 * Why not a shared package?
 * ─────────────────────────
 * The server uses `NodeNext` module resolution with a `rootDir: "src"`
 * emit boundary; the client uses `moduleResolution: "bundler"` under Vite.
 * Making them share a real TypeScript module means either project
 * references or a third workspace package. For a ~40-line type file the
 * ergonomics aren't worth it — a filesystem contract test is enough
 * enforcement:
 *
 *   - Rename a field in one file → this test fails.
 *   - Add / remove a member of the wire union in one file → this test fails.
 *   - Reformat one file → this test fails (which is intentional: a
 *     stylistic drift on one side WILL eventually turn into a semantic
 *     drift; catch it now).
 *
 * The test also verifies that both files declare the exact wire event
 * types the SSE handler ships and the client hook expects — a runtime
 * check that guards against the type-file being present but empty.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(here, '..')
const serverWirePath = resolve(
  workspaceRoot,
  'server',
  'src',
  'tasks',
  'wireEvents.ts',
)
const clientWirePath = resolve(
  workspaceRoot,
  'client',
  'src',
  'hooks',
  'taskEventWire.ts',
)

const BEGIN_MARKER = '/* WIRE-EVENTS:BEGIN */'
const END_MARKER = '/* WIRE-EVENTS:END */'

function extractContract(source: string, path: string): string {
  const beginIdx = source.indexOf(BEGIN_MARKER)
  const endIdx = source.indexOf(END_MARKER)
  if (beginIdx === -1) {
    throw new Error(
      `${path} is missing the '${BEGIN_MARKER}' marker — cannot verify wire contract.`,
    )
  }
  if (endIdx === -1 || endIdx <= beginIdx) {
    throw new Error(
      `${path} is missing (or reorders) the '${END_MARKER}' marker — cannot verify wire contract.`,
    )
  }
  return source.slice(beginIdx + BEGIN_MARKER.length, endIdx)
}

describe('SSE wire contract — server ↔ client parity', () => {
  it('both wire-type files exist and expose the sentinel markers', () => {
    const serverSource = readFileSync(serverWirePath, 'utf8')
    const clientSource = readFileSync(clientWirePath, 'utf8')
    expect(serverSource).toContain(BEGIN_MARKER)
    expect(serverSource).toContain(END_MARKER)
    expect(clientSource).toContain(BEGIN_MARKER)
    expect(clientSource).toContain(END_MARKER)
  })

  it('the contract block is byte-for-byte identical between server and client', () => {
    const serverSource = readFileSync(serverWirePath, 'utf8')
    const clientSource = readFileSync(clientWirePath, 'utf8')
    const serverContract = extractContract(serverSource, serverWirePath)
    const clientContract = extractContract(clientSource, clientWirePath)

    // Emitting the diff as the failure message would be nicer than the raw
    // strings, but vitest's default diff view is good enough here — the
    // failure body will show a full character-level diff.
    expect(clientContract).toBe(serverContract)
  })

  it('declares every event type the SSE handler ships', () => {
    // Guard against a future refactor that drops one of the required
    // events from the wire union. If any of these names is missing from
    // BOTH sides in the same commit the test above already fails; this
    // adds a second layer for readability so the error message pinpoints
    // which event went missing.
    const requiredTypes = [
      "'task-created'",
      "'task-deleted'",
      "'task-status'",
      "'run-created'",
      "'run-status'",
      "'run-log'",
    ]
    const serverSource = readFileSync(serverWirePath, 'utf8')
    const clientSource = readFileSync(clientWirePath, 'utf8')
    for (const literal of requiredTypes) {
      expect(
        serverSource,
        `server wire file is missing wire event literal ${literal}`,
      ).toContain(literal)
      expect(
        clientSource,
        `client wire file is missing wire event literal ${literal}`,
      ).toContain(literal)
    }
  })

  it('fails clearly when a marker is absent (regression check)', () => {
    // Simulate a broken source and make sure extractContract surfaces the
    // problem instead of silently returning an empty string.
    expect(() => extractContract('no markers here', '/fake/path')).toThrow(
      /missing.*WIRE-EVENTS:BEGIN/,
    )
    expect(() =>
      extractContract(`${BEGIN_MARKER}\ncontent`, '/fake/path'),
    ).toThrow(/missing.*WIRE-EVENTS:END/)
    expect(() =>
      extractContract(
        `${END_MARKER}\nreordered\n${BEGIN_MARKER}`,
        '/fake/path',
      ),
    ).toThrow(/missing.*WIRE-EVENTS:END/)
  })
})
