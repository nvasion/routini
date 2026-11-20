// Guards the nginx configs against a mistake no other test can see: a
// non-empty `types { ... }` block replaces nginx's whole inherited MIME map
// for its context. At server level that served every page, script and
// stylesheet as application/octet-stream (browsers download or refuse them).
// The manifest's type is therefore set with an empty `types { }` plus
// default_type inside its own location.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe.each(['nginx.conf', 'nginx.platform.conf'])('%s', (file) => {
  const conf = readFileSync(path.join(CLIENT_ROOT, file), 'utf8')

  it('never declares a non-empty types block', () => {
    const blocks = conf.match(/\btypes\s*\{[^}]*\}/g) ?? []
    for (const block of blocks) expect(block.replace(/\s+/g, '')).toBe('types{}')
  })

  it('serves the manifest with its own type', () => {
    expect(conf).toMatch(/location = \/manifest\.webmanifest \{[^}]*types \{ \}[^}]*default_type application\/manifest\+json;/)
  })

  it('keeps redirects relative behind the TLS proxy', () => {
    expect(conf).toMatch(/absolute_redirect off;/)
  })
})
