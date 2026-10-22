// Tests for the prerender build script's pure functions (no file I/O, no
// SSR bundle needed — vitest transforms entry-server.tsx through the same
// Vite/React pipeline it uses for every other test).

import { describe, expect, it } from 'vitest'
import { prerenderableRoutes, renderRoute } from '../src/entry-server'
import { addRobotsNoIndex, buildSitemap, escapeHtml, injectRouteHead, stripModuleScripts, stripSeoTags } from './prerender.mjs'

const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Routini</title>
    <meta name="description" content="placeholder" />
    <meta property="og:title" content="Routini" />
    <meta property="og:image" content="/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

describe('escapeHtml', () => {
  it('escapes all five HTML-special characters', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })
})

describe('injectRouteHead', () => {
  it('keeps a description containing "$1 and $&" intact (no regex-replacement corruption)', () => {
    const html = injectRouteHead(TEMPLATE, {
      meta: { title: 'T', description: 'Has $1 and $& inside', index: true, changefreq: 'weekly', priority: 1 },
      canonical: 'https://routini.tynhub.com/',
      image: 'https://routini.tynhub.com/og.png',
      siteName: 'Routini',
      jsonLd: [],
      bodyHtml: '<div>hi</div>',
    })
    // escapeHtml turns "&" into "&amp;"; "$1" has no HTML-special characters, so it survives untouched.
    expect(html).toContain('Has $1 and $&amp; inside')
    // A bug that used a *string* replacer (not a function) would turn "$1"/"$&" into
    // regex-capture artifacts instead of leaving them as literal text.
    expect(html).not.toContain('undefined')
  })

  it('adds noindex for a route whose metadata says index: false', () => {
    const html = injectRouteHead(TEMPLATE, {
      meta: { title: 'Sign in', description: 'Sign in to Routini.', index: false, changefreq: 'monthly', priority: 0.1 },
      canonical: 'https://routini.tynhub.com/login',
      image: 'https://routini.tynhub.com/og.png',
      siteName: 'Routini',
      jsonLd: [],
      bodyHtml: '<div>login</div>',
    })
    expect(html).toContain('<meta name="robots" content="noindex, follow">')
  })

  it('embeds each JSON-LD object as its own script tag that round-trips through JSON', () => {
    const jsonLd = [{ '@type': 'Thing', name: 'A "quoted" value' }]
    const html = injectRouteHead(TEMPLATE, {
      meta: { title: 'T', description: 'D'.padEnd(72, 'x'), index: true, changefreq: 'weekly', priority: 1 },
      canonical: 'https://routini.tynhub.com/',
      image: 'https://routini.tynhub.com/og.png',
      siteName: 'Routini',
      jsonLd,
      bodyHtml: '<div/>',
    })
    const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)
    expect(match).toBeTruthy()
    expect(JSON.parse(match[1])).toEqual(jsonLd[0])
  })

  it('replaces the template SEO tags rather than duplicating them', () => {
    const html = injectRouteHead(TEMPLATE, {
      meta: { title: 'New title', description: 'D'.padEnd(72, 'x'), index: true, changefreq: 'weekly', priority: 1 },
      canonical: 'https://routini.tynhub.com/',
      image: 'https://routini.tynhub.com/og.png',
      siteName: 'Routini',
      jsonLd: [],
      bodyHtml: '<div/>',
    })
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(html).toContain('<title>New title</title>')
    expect(html).not.toContain('placeholder')
  })
})

describe('stripSeoTags', () => {
  it('removes the title, description, OG, Twitter and canonical tags', () => {
    const stripped = stripSeoTags(TEMPLATE)
    expect(stripped).not.toMatch(/<title>/)
    expect(stripped).not.toMatch(/name="description"/)
    expect(stripped).not.toMatch(/property="og:/)
    expect(stripped).not.toMatch(/name="twitter:/)
  })
})

describe('addRobotsNoIndex', () => {
  it('adds a noindex meta tag once', () => {
    const html = addRobotsNoIndex(TEMPLATE)
    expect(html.match(/<meta name="robots" content="noindex">/g)).toHaveLength(1)
  })
})

describe('stripModuleScripts', () => {
  it('removes every <script type="module"> tag, e.g. for the 404 page', () => {
    const stripped = stripModuleScripts(TEMPLATE)
    expect(stripped).not.toMatch(/<script[^>]*type="module"/)
    expect(stripped).toContain('<div id="root">')
  })

  it('does not treat a comment merely mentioning <script type="module"> as a real tag', () => {
    // index.html's dev-only Fast Refresh fallback comment literally contains the text
    // `<script type="module">`; a naive regex can mistake that for an opening tag and
    // swallow everything up to the next *real* </script>, deleting unrelated content.
    const withCommentThatMentionsScript = `<!doctype html><head>
      <!-- In dev, Vite injects a <script type="module"> that imports /@react-refresh -->
      <script>window.$RefreshReg$ = function () {};</script>
      <script type="module" src="/src/main.tsx"></script>
    </head><body><div id="root"></div></body>`
    const stripped = stripModuleScripts(withCommentThatMentionsScript)
    expect(stripped).toContain('$RefreshReg$')
    expect(stripped).not.toMatch(/<script[^>]*type="module"/)
  })
})

describe('buildSitemap', () => {
  it('lists every entry with an absolute loc, changefreq and one-decimal priority', () => {
    const xml = buildSitemap('https://routini.tynhub.com', [
      { path: '/', meta: { changefreq: 'weekly', priority: 1 } },
      { path: '/pricing', meta: { changefreq: 'monthly', priority: 0.8 } },
    ])
    expect(xml).toContain('<loc>https://routini.tynhub.com/</loc>')
    expect(xml).toContain('<loc>https://routini.tynhub.com/pricing</loc>')
    expect(xml).toContain('<priority>1.0</priority>')
    expect(xml).toContain('<changefreq>monthly</changefreq>')
  })
})

describe('renderRoute (entry-server)', () => {
  it('every index:true route renders with exactly one <h1>', () => {
    expect(prerenderableRoutes.length).toBeGreaterThan(0)
    for (const route of prerenderableRoutes) {
      const html = renderRoute(route)
      expect(html, `renderRoute("${route}") returned null`).toBeTruthy()
      const h1Count = (html.match(/<h1[\s>]/g) ?? []).length
      expect(h1Count, `expected exactly one <h1> for "${route}", saw ${h1Count}`).toBe(1)
    }
  })

  it('returns null for a route with no page', () => {
    expect(renderRoute('/does-not-exist')).toBeNull()
  })
})
