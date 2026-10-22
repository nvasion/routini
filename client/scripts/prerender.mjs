// Prerenders every index:true public route to static HTML, after `vite
// build` (the SPA) and `vite build --ssr` (dist-ssr/entry-server.js) have
// both run — see the "build" script in package.json.
//
// dist/index.html is read once as the template. From it we write:
//   - dist/spa.html         the untouched template + <meta robots noindex>,
//                            the fallback nginx serves for app routes (login,
//                            signup, /app, /o/*, ...) that never prerender.
//   - dist/<route>/index.html (dist/index.html for "/") for every indexed
//                            route: its own title, description, canonical,
//                            Open Graph/Twitter tags, JSON-LD, and the
//                            rendered markup inside #root.
//   - dist/404.html         renderNotFound(), noindex, with every module
//                            script stripped so the SPA can never boot and
//                            redirect a crawler away from the 404 status.
//   - dist/sitemap.xml       every indexed route, absolute, with its
//                            changefreq and priority.
//
// Every string substitution below uses a FUNCTION replacer (never a bare
// replacement string), because String.prototype.replace treats sequences
// like "$1" or "$&" in a *string* replacement specially — and titles or
// descriptions are free text that could contain either literally.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = path.resolve(__dirname, '..')
const DIST = path.join(CLIENT_ROOT, 'dist')
const SSR_ENTRY = path.join(CLIENT_ROOT, 'dist-ssr', 'entry-server.js')

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, () => '&amp;')
    .replace(/</g, () => '&lt;')
    .replace(/>/g, () => '&gt;')
    .replace(/"/g, () => '&quot;')
    .replace(/'/g, () => '&#39;')
}

const SEO_TAG_PATTERNS = [
  /<title>.*?<\/title>/gis,
  /<meta[^>]*\bname=["']description["'][^>]*>/gi,
  /<meta[^>]*\bproperty=["']og:[a-z_]+["'][^>]*>/gi,
  /<meta[^>]*\bname=["']twitter:[a-z_]+["'][^>]*>/gi,
  /<meta[^>]*\bname=["']robots["'][^>]*>/gi,
  /<link[^>]*\brel=["']canonical["'][^>]*>/gi,
]

/** Strips the template's one-size-fits-all title/description/OG/Twitter/canonical/robots tags. */
export function stripSeoTags(html) {
  return SEO_TAG_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, () => ''), html)
}

/** Strips HTML comments first — index.html's dev-tooling comment *mentions* `<script type="module">`
 *  as plain text, and without this a real </script> further down would get swept up with it. */
export function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, () => '')
}

/** The <script type="module">…</script> tags that boot the SPA (and could redirect a crawler away from a 404). */
export function stripModuleScripts(html) {
  return stripHtmlComments(html).replace(/<script\b[^>]*\btype=["']module["'][^>]*>[\s\S]*?<\/script>/gi, () => '')
}

export function insertBeforeHeadClose(html, block) {
  return html.replace(/<\/head>/i, () => `${block}\n  </head>`)
}

/** Builds the <title>/<meta>/<link>/<script type="application/ld+json"> block for one route. */
export function buildHeadBlock({ meta, canonical, image, siteName, jsonLd }) {
  const title = escapeHtml(meta.title)
  const description = escapeHtml(meta.description)
  const url = escapeHtml(canonical)
  const lines = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${url}">`,
  ]
  if (!meta.index) lines.push('<meta name="robots" content="noindex, follow">')
  lines.push(
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${url}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
  )
  for (const entry of jsonLd) lines.push(`<script type="application/ld+json">${JSON.stringify(entry)}</script>`)
  return lines.join('\n    ')
}

/** Replaces the template's head tags with this route's, and its #root with the rendered markup. */
export function injectRouteHead(template, { meta, canonical, image, siteName, jsonLd, bodyHtml }) {
  const withHead = insertBeforeHeadClose(stripSeoTags(template), buildHeadBlock({ meta, canonical, image, siteName, jsonLd }))
  return setRootContent(withHead, bodyHtml)
}

export function setRootContent(html, bodyHtml) {
  return html.replace(/<div id="root"><\/div>/, () => `<div id="root">${bodyHtml}</div>`)
}

export function addRobotsNoIndex(html) {
  return insertBeforeHeadClose(html, '<meta name="robots" content="noindex">')
}

export function buildSitemap(origin, entries) {
  const urls = entries
    .map(
      ({ path: routePath, meta }) =>
        `  <url>\n    <loc>${escapeHtml(origin + routePath)}</loc>\n    <changefreq>${meta.changefreq}</changefreq>\n    <priority>${meta.priority.toFixed(1)}</priority>\n  </url>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/** Where a route's prerendered file lives under dist/. "/" is dist/index.html itself. */
function outputPathFor(routePath) {
  if (routePath === '/') return path.join(DIST, 'index.html')
  return path.join(DIST, routePath.replace(/^\//, ''), 'index.html')
}

async function main() {
  const template = await readFile(path.join(DIST, 'index.html'), 'utf8')

  // The SPA fallback for routes that never prerender (login, signup, /app, /o/*, ...).
  await writeFile(path.join(DIST, 'spa.html'), addRobotsNoIndex(template), 'utf8')

  const ssr = await import(pathToFileUrl(SSR_ENTRY))
  const { prerenderableRoutes, renderRoute, renderNotFound, pageMeta, jsonLdForRoute, site } = ssr

  const entries = []
  for (const routePath of prerenderableRoutes) {
    const meta = pageMeta(routePath)
    const bodyHtml = renderRoute(routePath)
    if (!bodyHtml) throw new Error(`prerender: renderRoute("${routePath}") produced no markup for an index:true route`)
    const html = injectRouteHead(template, {
      meta,
      canonical: `${site.origin}${routePath}`,
      image: `${site.origin}${site.image}`,
      siteName: site.name,
      jsonLd: jsonLdForRoute(routePath),
      bodyHtml,
    })
    const outPath = outputPathFor(routePath)
    await mkdir(path.dirname(outPath), { recursive: true })
    await writeFile(outPath, html, 'utf8')
    entries.push({ path: routePath, meta })
  }

  const notFoundHtml = setRootContent(stripModuleScripts(addRobotsNoIndex(stripSeoTags(template))), renderNotFound())
  await writeFile(path.join(DIST, '404.html'), notFoundHtml, 'utf8')

  await writeFile(path.join(DIST, 'sitemap.xml'), buildSitemap(site.origin, entries), 'utf8')

  console.log(`prerendered ${entries.length} route(s), spa.html, 404.html and sitemap.xml`)
}

function pathToFileUrl(p) {
  return `file://${p.split(path.sep).join('/')}`
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
