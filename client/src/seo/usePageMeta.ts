// Keeps the document head in sync with pageMeta.json on client-side
// navigation. The prerendered HTML for each indexed route already has the
// right tags baked in by scripts/prerender.mjs; this hook only matters once
// React has hydrated and the app starts navigating between routes itself.

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { absoluteImageUrl, canonicalUrl, site, tryPageMeta } from './pageMeta'

function upsertMeta(attr: 'name' | 'property', key: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function removeMeta(attr: 'name' | 'property', key: string): void {
  document.head.querySelector(`meta[${attr}="${key}"]`)?.remove()
}

function upsertCanonical(href: string): void {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

/** Sets title, description, canonical, robots and Open Graph/Twitter tags for the current path. */
export function usePageMeta(): void {
  const { pathname } = useLocation()
  useEffect(() => {
    const meta = tryPageMeta(pathname)
    if (!meta) return
    document.title = meta.title
    upsertMeta('name', 'description', meta.description)
    upsertCanonical(canonicalUrl(pathname))
    if (meta.index) removeMeta('name', 'robots')
    else upsertMeta('name', 'robots', 'noindex, follow')
    upsertMeta('property', 'og:title', meta.title)
    upsertMeta('property', 'og:description', meta.description)
    upsertMeta('property', 'og:url', canonicalUrl(pathname))
    upsertMeta('property', 'og:type', 'website')
    upsertMeta('property', 'og:site_name', site.name)
    upsertMeta('property', 'og:image', absoluteImageUrl())
    upsertMeta('name', 'twitter:card', 'summary_large_image')
    upsertMeta('name', 'twitter:title', meta.title)
    upsertMeta('name', 'twitter:description', meta.description)
    upsertMeta('name', 'twitter:image', absoluteImageUrl())
  }, [pathname])
}
