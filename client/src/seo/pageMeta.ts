// Single source of truth for per-route SEO metadata. Edit copy only in
// pageMeta.json: usePageMeta, jsonLd.ts and scripts/prerender.mjs all read
// through this module, so the live site, the prerendered HTML and the tests
// can never drift from each other.

import raw from './pageMeta.json'

export type Changefreq = 'weekly' | 'monthly' | 'yearly'

export interface SiteMeta {
  origin: string
  name: string
  image: string
  imageWidth: number
  imageHeight: number
}

export interface RouteMeta {
  title: string
  description: string
  index: boolean
  changefreq: Changefreq
  priority: number
}

interface PageMetaFile {
  site: SiteMeta
  routes: Record<string, RouteMeta>
}

const data = raw as PageMetaFile

export const site: SiteMeta = data.site

/** All known public-ish routes (sign-in and account pages included), in file order. */
export function allRoutes(): string[] {
  return Object.keys(data.routes)
}

/** Routes that should be prerendered, linked from the sitemap and left indexable. */
export function prerenderableRoutes(): string[] {
  return allRoutes().filter((path) => data.routes[path]!.index)
}

/** Metadata for `path`, or null when the route has none (e.g. the 404 page). */
export function tryPageMeta(path: string): RouteMeta | null {
  return data.routes[path] ?? null
}

/** Metadata for `path`. Throws for a route that was never added to pageMeta.json. */
export function pageMeta(path: string): RouteMeta {
  const meta = tryPageMeta(path)
  if (!meta) throw new Error(`No page metadata for route "${path}" — add it to src/seo/pageMeta.json`)
  return meta
}

export function canonicalUrl(path: string): string {
  return `${site.origin}${path}`
}

export function absoluteImageUrl(): string {
  return `${site.origin}${site.image}`
}
