// Builds the console's icons and the social card from the cut-out art
// (brand/art, from cutout.py): favicon PNGs, app icons, and og.png.
//
//   python3 brand/cutout.py && node brand/export.mjs && python3 brand/make_ico.py
//
// Needs Playwright (Chromium). If it isn't installed in this repo, point at one:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node brand/export.mjs

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT).href : 'playwright')
const ART = join(here, 'art')
const PUBLIC = join(here, '..', 'client', 'public')
mkdirSync(PUBLIC, { recursive: true })
// Images and fonts are embedded as data URLs: a setContent page cannot load file:// URLs.
const png = (f) => `data:image/png;base64,${readFileSync(join(ART, f)).toString('base64')}`
const fonts = join(here, '..', 'client', 'node_modules', '@fontsource')
const font = (pkg, file) => `data:font/woff2;base64,${readFileSync(join(fonts, pkg, 'files', file)).toString('base64')}`
const css = `
@font-face { font-family: 'Barlow Semi Condensed'; font-weight: 700; src: url(${font('barlow-semi-condensed', 'barlow-semi-condensed-latin-700-normal.woff2')}); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 400; src: url(${font('ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2')}); }
body { margin: 0; }
img { display: block; }
`

const browser = await chromium.launch()
async function render(path, html, w, h, transparent = false) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.setContent(`<style>${css}</style>${html}`)
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => i.decode()))
  })
  await page.screenshot({ path, omitBackground: transparent })
  await page.close()
}
const centered = (inner, w, h, bg) => `<div style="width:${w}px;height:${h}px;background:${bg};display:flex;align-items:center;justify-content:center">${inner}</div>`
const emblem = (px) => `<img src="${png('emblem-512.png')}" width="${px}" height="${px}">`

// App icons: the emblem on the Routini ground (platforms add their own rounding).
await render(join(PUBLIC, 'apple-touch-icon.png'), centered(emblem(150), 180, 180, '#0b0b0d'), 180, 180)
await render(join(PUBLIC, 'icon-192.png'), centered(emblem(160), 192, 192, '#0b0b0d'), 192, 192)
await render(join(PUBLIC, 'icon-512.png'), centered(emblem(430), 512, 512, '#0b0b0d'), 512, 512)
// Favicon PNGs (transparent); make_ico.py packs them into favicon.ico.
for (const px of [16, 32, 48]) await render(join(ART, `favicon-${px}.png`), centered(emblem(px), px, px, 'transparent'), px, px, true)
await render(join(PUBLIC, 'favicon-32.png'), centered(emblem(32), 32, 32, 'transparent'), 32, 32, true)

// Social card: the art on its own paper-coloured ground, with the tagline.
const og = `
<div style="width:1200px;height:630px;background:#f3f0e8;display:flex;align-items:center;justify-content:center;gap:64px;border-top:8px solid #c8261b;box-sizing:border-box">
  <img src="${png('emblem-512.png')}" width="330" height="330">
  <div style="display:flex;flex-direction:column;gap:26px">
    <img src="${png('wordmark.png')}" width="560">
    <span style="font-family:'Barlow Semi Condensed';font-weight:700;font-size:46px;color:#b8331a;letter-spacing:0.02em;padding-left:8px">Your AI engineer, on call.</span>
    <span style="font-family:'IBM Plex Mono';font-size:22px;color:#5c5852;letter-spacing:0.08em;padding-left:10px">JOBS · FLEET · INCIDENTS · ON TYNHUB</span>
  </div>
</div>`
await render(join(PUBLIC, 'og.png'), og, 1200, 630)

await browser.close()
console.log('exported icons and og.png to client/public')
