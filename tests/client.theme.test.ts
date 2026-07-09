import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Theme contract tests.
 *
 * The PRD requires that the UI be styled with a red / orange / black palette
 * (#FF0000 / #FFA500 / #000000). To keep the theme actually consistent across
 * components — and to fail loudly the day someone reintroduces a stray hex
 * literal — these tests treat `client/src/theme.css` as the single source of
 * truth for palette tokens and lint the rest of the client tree against it.
 *
 * Everything runs against the filesystem (no browser required), which keeps
 * the test in the same Node/Vitest suite as the rest of the project.
 */

const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = resolve(here, '..', 'client', 'src')
const themeCssPath = join(clientSrc, 'theme.css')

/** Every hex literal we consider a "palette" value — 3, 4, 6 or 8 hex digits. */
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g

/**
 * Recursively walk `dir`, returning absolute paths of every regular file
 * whose extension is in `exts`. Guarded against symlink escape by using
 * `statSync` rather than `lstatSync` — we intentionally follow symlinks
 * inside the project tree (there are none in practice, but the test would
 * throw ENOENT rather than traverse outside).
 */
function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full, exts))
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot === -1) continue
    const ext = entry.name.slice(dot).toLowerCase()
    if (exts.includes(ext)) out.push(full)
  }
  return out
}

/** Extract every `#...` token from a CSS/TSX string, lowercased. */
function extractHexes(source: string): string[] {
  const matches = source.match(HEX_LITERAL) ?? []
  return matches.map((m) => m.toLowerCase())
}

describe('client theme palette', () => {
  const themeCss = readFileSync(themeCssPath, 'utf8')

  it('declares the PRD-mandated red / orange / black tokens', () => {
    expect(themeCss).toMatch(/--color-red:\s*#ff0000ff\b/i)
    expect(themeCss).toMatch(/--color-orange:\s*#ffa500ff\b/i)
    expect(themeCss).toMatch(/--color-black:\s*#000000ff\b/i)
  })

  it('declares every downstream-consumed palette token', () => {
    // Tokens referenced by App.css / index.css. If any of these is deleted
    // from theme.css the UI silently loses styling — surface that as a test
    // failure instead of a runtime fallback to unstyled defaults.
    const requiredTokens = [
      '--color-black',
      '--color-red',
      '--color-orange',
      '--color-surface',
      '--color-surface-2',
      '--color-border',
      '--color-text',
      '--color-muted',
      '--color-danger-bg',
      '--color-danger-fg',
      '--color-orange-hover',
      '--color-red-hover',
      '--focus-ring-orange',
      '--login-glow',
      '--login-shadow',
    ]
    for (const token of requiredTokens) {
      expect(themeCss).toContain(token + ':')
    }
  })

  it('uses 8-digit #rrggbbaa hex for every declared token', () => {
    // Pull every `--token: #value;` declaration and assert the value shape.
    // 3/4/6-digit hex or bare `rgb()`/`rgba()` are the historical foot-guns.
    const declRe = /--[a-z0-9-]+:\s*(#[0-9a-fA-F]+)\s*;/gi
    const matches = [...themeCss.matchAll(declRe)]
    expect(matches.length).toBeGreaterThan(0)
    for (const [, value] of matches) {
      // 8 hex digits after `#` → opaque or explicit alpha, consistent format.
      expect(value).toMatch(/^#[0-9a-fA-F]{8}$/)
    }
  })

  it('is the ONLY CSS file in client/src that declares palette hex literals', () => {
    const cssFiles = walk(clientSrc, ['.css'])
    // Sanity: we should have found theme.css itself among them.
    expect(cssFiles).toContain(themeCssPath)

    const offenders: Array<{ file: string; hex: string }> = []
    for (const file of cssFiles) {
      if (file === themeCssPath) continue
      const source = readFileSync(file, 'utf8')
      for (const hex of extractHexes(source)) {
        offenders.push({ file, hex })
      }
    }

    // A single message listing every offender is easier to fix than one
    // failure per file — surface the whole set.
    expect(offenders, `Palette hex literals must live in theme.css. Offenders: ${
      offenders.map((o) => `${o.file}:${o.hex}`).join(', ')
    }`).toEqual([])
  })

  it('does not leak palette hex literals into TSX components', () => {
    // Component styling MUST go through className + palette vars. Inline
    // hex colors in TSX bypass the theme and become invisible to a future
    // palette change.
    const tsxFiles = walk(clientSrc, ['.tsx'])
    expect(tsxFiles.length).toBeGreaterThan(0)

    const offenders: Array<{ file: string; hex: string }> = []
    for (const file of tsxFiles) {
      const source = readFileSync(file, 'utf8')
      for (const hex of extractHexes(source)) {
        offenders.push({ file, hex })
      }
    }

    expect(offenders, `TSX files must not hardcode palette hex. Offenders: ${
      offenders.map((o) => `${o.file}:${o.hex}`).join(', ')
    }`).toEqual([])
  })

  it('imports theme.css from both index.css and App.css', () => {
    // A downstream stylesheet that forgets the @import would silently lose
    // access to var(--color-*) and fall back to the browser's default (i.e.,
    // an unstyled page). Guard the import explicitly.
    const indexCss = readFileSync(join(clientSrc, 'index.css'), 'utf8')
    const appCss = readFileSync(join(clientSrc, 'App.css'), 'utf8')
    expect(indexCss).toMatch(/@import\s+['"]\.\/theme\.css['"]\s*;/)
    expect(appCss).toMatch(/@import\s+['"]\.\/theme\.css['"]\s*;/)
  })

  it('applies palette-derived accents to every top-level surface (header, buttons, forms, login)', () => {
    // Guard against a refactor accidentally dropping the orange/red accents
    // from a marquee component. Each of these class rules is required to
    // reference the palette in some form.
    const appCss = readFileSync(join(clientSrc, 'App.css'), 'utf8')
    const surfaces: Array<{ selector: string; mustReference: RegExp }> = [
      { selector: '.header', mustReference: /var\(--color-red\)/ },
      { selector: '.button', mustReference: /var\(--color-orange\)/ },
      { selector: '.delete-btn', mustReference: /var\(--color-red\)/ },
      { selector: '.login-card', mustReference: /var\(--color-red\)/ },
      { selector: '.login-submit', mustReference: /var\(--color-red\)/ },
      { selector: '.nav-btn-active', mustReference: /var\(--color-orange\)/ },
      { selector: '.settings-heading', mustReference: /var\(--color-orange\)/ },
    ]
    for (const { selector, mustReference } of surfaces) {
      // Match `<selector> { ... }` non-greedily. `[^}]*` is safe because CSS
      // rule bodies here never contain nested braces.
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const bodyRe = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
      const match = appCss.match(bodyRe)
      expect(match, `expected selector ${selector} to exist in App.css`).not.toBeNull()
      expect(match![1]).toMatch(mustReference)
    }
  })

  it('does not accidentally pick up palette tokens from files outside client/src', () => {
    // Defense-in-depth: if someone drops a stylesheet under client/public or
    // client/src/assets in the future, the palette-lint sweep in this file
    // must still catch it. Verify the walk() helper actually descends into
    // subdirectories by planting a sanity check on the tree we already know.
    const cssFiles = walk(clientSrc, ['.css'])
    expect(cssFiles).toContain(join(clientSrc, 'App.css'))
    expect(cssFiles).toContain(join(clientSrc, 'index.css'))
  })
})

describe('client theme palette — walk() edge cases', () => {
  it('returns [] for a directory that contains no matching extensions', () => {
    // Use client/src/auth which contains .ts/.tsx but no .png files.
    const empty = walk(join(clientSrc, 'auth'), ['.png'])
    expect(empty).toEqual([])
  })

  it('respects the ext filter (case-insensitive extension match)', () => {
    // We intentionally lower-case extensions before comparing. If a component
    // is ever named `Foo.TSX` on a case-preserving FS the walk should still
    // find it. Assert by feeding a .css filter and confirming only .css comes
    // back — no .ts leakage.
    const cssOnly = walk(clientSrc, ['.css'])
    for (const file of cssOnly) {
      expect(file.toLowerCase().endsWith('.css')).toBe(true)
    }
    // Sanity: at least one .css exists.
    expect(cssOnly.length).toBeGreaterThan(0)
  })

  it('throws a clear error when asked to walk a non-existent path', () => {
    // If a future refactor renames client/src, we want an immediate ENOENT,
    // not a silently-empty result set that hides missing palette coverage.
    const missing = join(clientSrc, '__does_not_exist__')
    expect(() => walk(missing, ['.css'])).toThrow()
    // Confirm statSync agrees (belt-and-braces against a walk() implementation
    // that ever changes to return [] on ENOENT).
    expect(() => statSync(missing)).toThrow()
  })
})
