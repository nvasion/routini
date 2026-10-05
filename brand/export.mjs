// Renders the brand SVGs (brand/svg, from make_mark.py) into the raster set:
// transparent marks and lockups, the social card, app icons and favicon PNGs.
//
//   python3 brand/make_mark.py && node brand/export.mjs
//
// Needs Playwright (Chromium). If it isn't installed in this repo, point at one:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node brand/export.mjs
// Then build favicon.ico from the PNGs: python3 brand/make_ico.py

import { mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright')
const svg = (f) => readFileSync(join(here, 'svg', f), 'utf8')
const fonts = join(here, '..', 'client', 'node_modules', '@fontsource')
// Embedded as data URLs: a setContent page cannot load file:// fonts.
const font = (pkg, file) => `data:font/woff2;base64,${readFileSync(join(fonts, pkg, 'files', file)).toString('base64')}`
const PNG = join(here, 'png')
const PUBLIC = join(here, '..', 'client', 'public')
mkdirSync(PNG, { recursive: true })
mkdirSync(PUBLIC, { recursive: true })

const css = `
@font-face { font-family: 'Barlow Semi Condensed'; font-weight: 700; src: url(${font('barlow-semi-condensed', 'barlow-semi-condensed-latin-700-normal.woff2')}); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 400; src: url(${font('ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2')}); }
body { margin: 0; }
.word { font-family: 'Barlow Semi Condensed'; font-weight: 700; letter-spacing: 0.04em; line-height: 1; }
.sub { font-family: 'IBM Plex Mono'; letter-spacing: 0.08em; }
`

const browser = await chromium.launch()
async function render(name, html, w, h, opts = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: opts.scale ?? 1 })
  await page.setContent(`<style>${css}</style>${html}`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: name, omitBackground: !!opts.transparent })
  await page.close()
}
const box = (inner, w, h, bg = 'transparent', pad = 0) =>
  `<div style="width:${w}px;height:${h}px;background:${bg};display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:${pad}px">${inner}</div>`
const sized = (s, px) => `<div style="width:${px}px;height:${px}px">${s}</div>`

// Marks on transparent ground (choose by the ground they will sit on).
for (const [file, out] of [
  ['mark-on-dark.svg', 'mark-on-dark-512.png'],
  ['mark-on-light.svg', 'mark-on-light-512.png'],
  ['glyph-on-dark.svg', 'glyph-on-dark-512.png'],
  ['glyph-on-light.svg', 'glyph-on-light-512.png'],
]) {
  await render(join(PNG, out), box(sized(svg(file), 512), 512, 512), 512, 512, { transparent: true })
}

// Horizontal lockups: mark + wordmark.
const lockup = (markFile, ink) =>
  `<div style="display:flex;align-items:center;gap:36px;padding:0 24px">${sized(svg(markFile), 200)}<span class="word" style="font-size:150px;color:${ink}">ROUTINI</span></div>`
await render(join(PNG, 'lockup-on-dark.png'), box(lockup('mark-on-dark.svg', '#f4f1ec'), 1000, 260), 1000, 260, { transparent: true })
await render(join(PNG, 'lockup-on-light.png'), box(lockup('mark-on-light.svg', '#16171a'), 1000, 260), 1000, 260, { transparent: true })

// Social card (Open Graph / link previews).
const og = `
<div style="width:1200px;height:630px;background:#0b0b0d;position:relative;overflow:hidden;font-family:sans-serif">
  <div style="position:absolute;inset:0;border-top:6px solid #ff2d1f"></div>
  <div style="position:absolute;left:96px;top:0;bottom:0;display:flex;align-items:center;gap:56px">
    ${sized(svg('mark-on-dark.svg'), 300)}
    <div style="display:flex;flex-direction:column;gap:22px">
      <span class="word" style="font-size:150px;color:#f4f1ec">ROUTINI</span>
      <span style="font-family:'Barlow Semi Condensed';font-weight:700;font-size:44px;color:#ffa53d;letter-spacing:0.02em">Your AI engineer, on call.</span>
      <span class="sub" style="font-size:22px;color:#a8a39b">JOBS · FLEET · INCIDENTS · ON TYNHUB</span>
    </div>
  </div>
</div>`
await render(join(PNG, 'og.png'), og, 1200, 630)

// App icons: the full mark on the Routini ground (platforms add their own rounding).
const icon = (px, markPx) => box(sized(svg('mark-on-dark.svg'), markPx), px, px, '#0b0b0d')
await render(join(PUBLIC, 'apple-touch-icon.png'), icon(180, 140), 180, 180)
await render(join(PUBLIC, 'icon-192.png'), icon(192, 150), 192, 192)
await render(join(PUBLIC, 'icon-512.png'), icon(512, 400), 512, 512)
// Favicon PNGs (for favicon.ico): the glyph, transparent, mid-steel so it reads on light and dark tabs.
const favGlyph = svg('glyph-on-light.svg').replace(/#1d1e22/g, '#5d616b')
for (const px of [16, 32, 48]) await render(join(PNG, `favicon-${px}.png`), box(sized(favGlyph, px), px, px), px, px, { transparent: true })

copyFileSync(join(here, 'svg', 'favicon.svg'), join(PUBLIC, 'favicon.svg'))
copyFileSync(join(PNG, 'og.png'), join(PUBLIC, 'og.png'))
await browser.close()
console.log('exported to brand/png and client/public')
