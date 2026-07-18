/**
 * CSS theme tests.
 *
 * Validates that:
 *  1. index.css defines the canonical red / orange / black design tokens
 *     at their exact spec values.
 *  2. The body rule in index.css uses CSS variables, not hardcoded overrides.
 *  3. Key stylesheet files (App.css, LoginPage.css) use CSS variables for
 *     their primary color properties instead of hardcoded hex values that
 *     diverge from the theme palette.
 *  4. Every CSS file that participates in the theme references the design
 *     tokens rather than re-introducing off-palette hardcoded colours for
 *     backgrounds, text, and borders.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// ── Helpers ────────────────────────────────────────────────────────────────────

const CLIENT_SRC = path.resolve(__dirname, '../client/src')

function readCss(relPath: string): string {
  return readFileSync(path.join(CLIENT_SRC, relPath), 'utf-8')
}

// ── index.css ─────────────────────────────────────────────────────────────────

describe('index.css – design token definitions', () => {
  const css = readCss('index.css')

  it('defines --color-primary as #ff0000 (red)', () => {
    expect(css).toMatch(/--color-primary\s*:\s*#ff0000/i)
  })

  it('defines --color-secondary as #ffa500 (orange)', () => {
    expect(css).toMatch(/--color-secondary\s*:\s*#ffa500/i)
  })

  it('defines --color-bg as #000000 (black)', () => {
    expect(css).toMatch(/--color-bg\s*:\s*#000000/i)
  })

  it('defines --color-bg-card for dark card surfaces', () => {
    expect(css).toMatch(/--color-bg-card\s*:/)
  })

  it('defines --color-bg-elevated for elevated surfaces', () => {
    expect(css).toMatch(/--color-bg-elevated\s*:/)
  })

  it('defines --color-text for foreground text', () => {
    expect(css).toMatch(/--color-text\s*:/)
  })

  it('defines --color-border for dividers and outlines', () => {
    expect(css).toMatch(/--color-border\s*:/)
  })

  it('body uses var(--color-bg) for background — no hardcoded override', () => {
    // Extract just the body rule block
    const bodyMatch = css.match(/body\s*\{([^}]+)\}/)
    expect(bodyMatch).not.toBeNull()
    const bodyBlock = bodyMatch![1]

    // Should reference the CSS variable
    expect(bodyBlock).toContain('var(--color-bg)')

    // Must NOT contain a second hardcoded background that would override the variable.
    // Count how many times "background" appears:
    const bgOccurrences = (bodyBlock.match(/background\s*:/g) ?? []).length
    expect(bgOccurrences).toBe(1)
  })

  it('body uses var(--color-text) for color — no hardcoded override', () => {
    const bodyMatch = css.match(/body\s*\{([^}]+)\}/)
    expect(bodyMatch).not.toBeNull()
    const bodyBlock = bodyMatch![1]

    expect(bodyBlock).toContain('var(--color-text)')

    // Count how many times "color" appears (excluding "border-color" etc.)
    const colorOccurrences = (bodyBlock.match(/(?<![a-z-])color\s*:/g) ?? []).length
    expect(colorOccurrences).toBe(1)
  })
})

// ── App.css ───────────────────────────────────────────────────────────────────

describe('App.css – uses theme variables', () => {
  const css = readCss('App.css')

  it('.input background uses var(--color-bg-elevated)', () => {
    expect(css).toContain('var(--color-bg-elevated)')
  })

  it('.input border-color uses var(--color-border)', () => {
    // The border shorthand or border-color property on .input should reference
    // the border variable, not a bare hardcoded dark hex value.
    expect(css).toMatch(/var\(--color-border\)/)
  })

  it('.input text color uses var(--color-text)', () => {
    expect(css).toMatch(/var\(--color-text\)/)
  })

  it('.input:focus border-color uses var(--color-secondary)', () => {
    expect(css).toMatch(/var\(--color-secondary\)/)
  })

  it('.list-item background uses var(--color-bg-card)', () => {
    expect(css).toMatch(/var\(--color-bg-card\)/)
  })

  it('.delete-btn color uses var(--color-primary)', () => {
    expect(css).toMatch(/var\(--color-primary\)/)
  })

  it('.empty color uses var(--color-text-muted)', () => {
    expect(css).toMatch(/var\(--color-text-muted\)/)
  })

  it('does not use off-palette hardcoded background hex for list or input', () => {
    // These specific off-palette values must not appear (they were replaced)
    expect(css).not.toMatch(/#1a1a1a/)
    expect(css).not.toMatch(/#2a2a2a/)
    expect(css).not.toMatch(/#111[^1]|#111$/)
    expect(css).not.toMatch(/#222[^2]|#222$/)
    expect(css).not.toMatch(/#dc3545/)
  })
})

// ── LoginPage.css ─────────────────────────────────────────────────────────────

describe('LoginPage.css – uses theme variables', () => {
  const css = readCss('LoginPage.css')

  it('.login-page background uses var(--color-bg)', () => {
    expect(css).toMatch(/\.login-page[\s\S]*?background\s*:\s*var\(--color-bg\)/)
  })

  it('.login-card background uses var(--color-bg-card)', () => {
    expect(css).toMatch(/\.login-card[\s\S]*?background\s*:\s*var\(--color-bg-card\)/)
  })

  it('.login-card border uses var(--color-border)', () => {
    expect(css).toMatch(/var\(--color-border\)/)
  })

  it('.login-logo h1 gradient uses var(--color-primary) and var(--color-secondary)', () => {
    expect(css).toContain('var(--color-primary)')
    expect(css).toContain('var(--color-secondary)')
  })

  it('.login-logo p color uses var(--color-text-muted)', () => {
    expect(css).toContain('var(--color-text-muted)')
  })

  it('.login-field input background uses var(--color-bg-elevated)', () => {
    expect(css).toContain('var(--color-bg-elevated)')
  })

  it('.login-field input color uses var(--color-text)', () => {
    expect(css).toContain('var(--color-text)')
  })

  it('.login-field input:focus border uses var(--color-secondary)', () => {
    // secondary is used for focus ring
    expect(css).toMatch(/var\(--color-secondary\)/)
  })

  it('.login-error color uses var(--color-primary)', () => {
    expect(css).toMatch(/var\(--color-primary\)/)
  })

  it('does not use off-palette hardcoded colours for structure', () => {
    // These raw hex values should all have been replaced with variables
    expect(css).not.toMatch(/#000[^0]|(?<![a-fA-F0-9])#000$/)  // bare #000
    expect(css).not.toMatch(/(?<![a-fA-F0-9])#111[^1]|(?<![a-fA-F0-9])#111$/)
    expect(css).not.toMatch(/(?<![a-fA-F0-9])#555[^5]|(?<![a-fA-F0-9])#555$/)
    expect(css).not.toMatch(/(?<![a-fA-F0-9])#888[^8]|(?<![a-fA-F0-9])#888$/)
    expect(css).not.toMatch(/#1a1a1a/)
    expect(css).not.toMatch(/#2a2a2a/)
    expect(css).not.toMatch(/#1e1e1e/)
    expect(css).not.toMatch(/(?<![a-fA-F0-9])#fff[^f]|(?<![a-fA-F0-9])#fff$/)
    expect(css).not.toMatch(/#444[^4]|(?<![a-fA-F0-9])#444$/)
  })
})

// ── Navbar.css ────────────────────────────────────────────────────────────────

describe('Navbar.css – uses theme variables', () => {
  const css = readCss('components/Navbar.css')

  it('.navbar background uses a theme variable', () => {
    expect(css).toMatch(/\.navbar[\s\S]*?background\s*:\s*var\(/)
  })

  it('.navbar-logo color uses var(--color-primary)', () => {
    expect(css).toMatch(/var\(--color-primary\)/)
  })

  it('.nav-link.active color uses var(--color-secondary)', () => {
    expect(css).toMatch(/var\(--color-secondary\)/)
  })

  it('.btn-primary background uses var(--color-primary)', () => {
    expect(css).toMatch(/\.btn-primary[\s\S]*?background\s*:\s*var\(--color-primary\)/)
  })
})

// ── TaskCard.css ──────────────────────────────────────────────────────────────

describe('TaskCard.css – uses theme variables', () => {
  const css = readCss('components/TaskCard.css')

  it('.task-card background uses var(--color-bg-card)', () => {
    expect(css).toMatch(/var\(--color-bg-card\)/)
  })

  it('.task-card:hover border uses var(--color-secondary)', () => {
    expect(css).toMatch(/var\(--color-secondary\)/)
  })

  it('.status-failed uses var(--color-primary) for colour', () => {
    expect(css).toMatch(/status-failed[\s\S]*?var\(--color-primary\)/)
  })
})

// ── Login.css (pages) ─────────────────────────────────────────────────────────

describe('pages/Login.css – uses theme variables', () => {
  const css = readCss('pages/Login.css')

  it('.login-page background uses a CSS variable', () => {
    expect(css).toMatch(/var\(--color-bg\)/)
  })

  it('.login-logo color uses var(--color-primary)', () => {
    expect(css).toMatch(/var\(--color-primary\)/)
  })

  it('.login-btn background uses var(--color-primary)', () => {
    expect(css).toMatch(/var\(--color-primary\)/)
  })

  it('.form-group input:focus border uses var(--color-secondary)', () => {
    expect(css).toMatch(/var\(--color-secondary\)/)
  })
})

// ── RoutineBuilder.css ────────────────────────────────────────────────────────

describe('RoutineBuilder.css – uses theme variables', () => {
  const css = readCss('components/RoutineBuilder.css')

  it('.rb background uses var(--color-bg-card)', () => {
    expect(css).toMatch(/var\(--color-bg-card\)/)
  })

  it('.rb-title gradient uses CSS variables for red and orange', () => {
    // Gradient must reference the design tokens, not hardcoded hex values
    expect(css).toMatch(/\.rb-title[\s\S]*?linear-gradient[\s\S]*?var\(--color-primary\)/)
    expect(css).toMatch(/\.rb-title[\s\S]*?linear-gradient[\s\S]*?var\(--color-secondary\)/)
  })

  it('.rb-step-num uses secondary colour for step indicator', () => {
    expect(css).toMatch(/var\(--color-secondary\)/)
  })

  it('.rb-btn-save gradient uses CSS variables for the red-to-orange progression', () => {
    expect(css).toMatch(/\.rb-btn-save[\s\S]*?background\s*:[\s\S]*?linear-gradient/)
    expect(css).toMatch(/var\(--color-primary-dark\)/)
    expect(css).toMatch(/var\(--color-secondary-dark\)/)
  })
})
