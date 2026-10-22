// Guards the metadata contract every public page depends on: unique,
// length-bounded copy, a sitemap that only ever lists indexable routes, and
// JSON-LD that can't drift from the FAQ copy it's built from.

import { describe, expect, it } from 'vitest'
import { FAQ, PRICING_FAQ } from '../pages/public/content'
import { jsonLdForRoute } from './jsonLd'
import { allRoutes, prerenderableRoutes, tryPageMeta } from './pageMeta'

describe('pageMeta', () => {
  const routes = allRoutes()

  it('has at least one route', () => {
    expect(routes.length).toBeGreaterThan(0)
  })

  it('gives every route a title under 65 characters', () => {
    for (const path of routes) {
      const meta = tryPageMeta(path)!
      expect(meta.title.length, `${path}: "${meta.title}"`).toBeGreaterThan(0)
      expect(meta.title.length, `${path}: "${meta.title}"`).toBeLessThanOrEqual(65)
    }
  })

  it('gives every route a description between 70 and 160 characters', () => {
    for (const path of routes) {
      const meta = tryPageMeta(path)!
      expect(meta.description.length, `${path}: "${meta.description}"`).toBeGreaterThanOrEqual(70)
      expect(meta.description.length, `${path}: "${meta.description}"`).toBeLessThanOrEqual(160)
    }
  })

  it('never reuses a title or description across routes', () => {
    const titles = routes.map((p) => tryPageMeta(p)!.title)
    const descriptions = routes.map((p) => tryPageMeta(p)!.description)
    expect(new Set(titles).size).toBe(titles.length)
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })

  it('tryPageMeta returns null for an unknown path instead of throwing', () => {
    expect(tryPageMeta('/no-such-route')).toBeNull()
  })

  it('lists exactly the index:true routes as prerenderable, and nothing else', () => {
    const prerenderable = new Set(prerenderableRoutes())
    for (const path of routes) {
      const meta = tryPageMeta(path)!
      if (meta.index) expect(prerenderable.has(path), `${path} is index:true but missing from prerenderableRoutes`).toBe(true)
      else expect(prerenderable.has(path), `${path} is index:false but listed in prerenderableRoutes (the sitemap source)`).toBe(false)
    }
  })
})

describe('jsonLdForRoute', () => {
  it('returns JSON-serializable objects for every prerenderable route', () => {
    for (const path of prerenderableRoutes()) {
      const entries = jsonLdForRoute(path)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) expect(() => JSON.parse(JSON.stringify(entry))).not.toThrow()
    }
  })

  it('builds the front page FAQPage from content.ts FAQ, so they cannot drift', () => {
    const faqPage = jsonLdForRoute('/').find((e) => e['@type'] === 'FAQPage') as { mainEntity: Array<{ name: string }> }
    expect(faqPage).toBeTruthy()
    expect(faqPage.mainEntity.map((q) => q.name)).toEqual(FAQ.map((f) => f.q))
  })

  it('builds the pricing FAQPage from content.ts PRICING_FAQ', () => {
    const faqPage = jsonLdForRoute('/pricing').find((e) => e['@type'] === 'FAQPage') as { mainEntity: Array<{ name: string }> }
    expect(faqPage).toBeTruthy()
    expect(faqPage.mainEntity.map((q) => q.name)).toEqual(PRICING_FAQ.map((f) => f.q))
  })

  it('strips HTML out of FAQ answers before they reach JSON-LD', () => {
    const faqPage = jsonLdForRoute('/').find((e) => e['@type'] === 'FAQPage') as {
      mainEntity: Array<{ acceptedAnswer: { text: string } }>
    }
    for (const q of faqPage.mainEntity) expect(q.acceptedAnswer.text).not.toMatch(/<[^>]+>/)
  })

  it('gives breadcrumbs to the secondary pages, and nothing to unknown or non-indexed paths', () => {
    for (const path of ['/how-it-works', '/privacy', '/terms']) {
      expect(jsonLdForRoute(path).some((e) => e['@type'] === 'BreadcrumbList')).toBe(true)
    }
    expect(jsonLdForRoute('/login')).toEqual([])
    expect(jsonLdForRoute('/does-not-exist')).toEqual([])
  })
})
