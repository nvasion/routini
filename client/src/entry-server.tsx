// SSR entry for scripts/prerender.mjs. Imports ONLY the public pages — never
// App.tsx, the console shell or xterm — so the SSR bundle stays small and
// never touches anything that assumes a browser. No hydration contract: the
// prerendered markup is thrown away and replaced by React on mount, same as
// a typical marketing-site prerender (see client/package.json's build step).

import type { ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { ThemeProvider } from './lib/theme'
import { LandingPage } from './pages/public/LandingPage'
import { HowItWorksPage } from './pages/public/HowItWorksPage'
import { PricingPage } from './pages/public/PricingPage'
import { PrivacyPage, TermsPage } from './pages/public/LegalPage'
import { NotFoundPage } from './pages/public/NotFoundPage'
import { prerenderableRoutes as metaPrerenderableRoutes } from './seo/pageMeta'

// Re-exported so scripts/prerender.mjs — a plain Node script that cannot
// import .ts files directly — gets metadata and JSON-LD from this one
// compiled SSR bundle, the same source every page itself reads from.
export { pageMeta, tryPageMeta, site, canonicalUrl, absoluteImageUrl } from './seo/pageMeta'
export { jsonLdForRoute } from './seo/jsonLd'

const PAGES: Record<string, () => ReactElement> = {
  '/': () => <LandingPage />,
  '/how-it-works': () => <HowItWorksPage />,
  '/pricing': () => <PricingPage />,
  '/privacy': () => <PrivacyPage />,
  '/terms': () => <TermsPage />,
}

/** Every route pageMeta.json marks index:true — the single source of truth, re-exported for prerender.mjs. */
export const prerenderableRoutes: string[] = metaPrerenderableRoutes()

/** Wraps a page with the (static, signed-out, no-fetch) providers it needs to render. */
function withProviders(path: string, page: ReactElement): ReactElement {
  return (
    <ThemeProvider>
      <AuthProvider>
        <StaticRouter location={path}>{page}</StaticRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}

/**
 * Renders `path` to an HTML string, or null when it isn't a known public
 * route. Auth and the "signup open" check never resolve during SSR (their
 * effects only run in the browser), so every page renders in its static,
 * signed-out state — exactly what a crawler without a session should see.
 */
export function renderRoute(path: string): string | null {
  const page = PAGES[path]
  if (!page) return null
  return renderToString(withProviders(path, page()))
}

export function renderNotFound(): string {
  return renderToString(withProviders('/404', <NotFoundPage />))
}
