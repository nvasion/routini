// Client-side 404: used when the router itself can't match a path (e.g. an
// org route that no longer exists). The static dist/404.html nginx serves
// for unknown public paths is generated separately by scripts/prerender.mjs.

import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { PublicLayout } from './PublicLayout'

export function NotFoundPage() {
  // Not in pageMeta.json (it has no URL of its own), so set the title and
  // noindex here; otherwise the previous page's title and canonical linger.
  useEffect(() => {
    document.title = 'Page not found - Routini'
    document.querySelector('link[rel="canonical"]')?.remove()
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]')
    if (!robots) {
      robots = document.createElement('meta')
      robots.name = 'robots'
      document.head.appendChild(robots)
    }
    robots.content = 'noindex'
  }, [])

  return (
    <PublicLayout>
      <div className="public-section" style={{ textAlign: 'center' }}>
        <h1 className="page-title">Page not found</h1>
        <p className="muted">That page doesn’t exist, or has moved.</p>
        <p className="inline" style={{ justifyContent: 'center', gap: 16 }}>
          <Link to="/">Home</Link>
          <Link to="/how-it-works">How it works</Link>
          <Link to="/pricing">Pricing</Link>
        </p>
      </div>
    </PublicLayout>
  )
}
