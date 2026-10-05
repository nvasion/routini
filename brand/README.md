# Routini brand

The mark is a flat redraw of the red/black emblem. Two bands, red over the top and steel under the bottom, turn as one loop: the routine. Inside it, a rising orange arrow splits the disc: automation moving things forward.

## Files

| File | Use |
|---|---|
| `svg/mark.svg` | Full mark, themeable (`--mark-*` CSS variables). Use it from about 40px up. |
| `svg/mark-glyph.svg` | Loop and arrow only, themeable. Use it below about 40px: the header and anything small. |
| `svg/mark-on-dark.svg`, `svg/mark-on-light.svg` | Full mark with fixed colours, for dark and light grounds. |
| `svg/glyph-on-dark.svg`, `svg/glyph-on-light.svg` | Glyph with fixed colours. |
| `svg/favicon.svg` | Browser tab icon. The steel follows the tab's light or dark scheme. |
| `png/mark-on-*-512.png`, `png/glyph-on-*-512.png` | Transparent PNGs. |
| `png/lockup-on-dark.png`, `png/lockup-on-light.png` | Mark plus wordmark, transparent. |
| `png/og.png` | Social card (1200×630), also served at `/og.png`. |

The console's favicon, app icons and manifest live in `client/public/`. The themeable SVGs the console inlines live in `client/src/brand/`.

## Colours

| Role | Value | Notes |
|---|---|---|
| Red | `#e3261b` | The top band. Identity colour. |
| Red, deep | `#a11c15` | Upper half of the disc. |
| Steel on dark | `#8d919b` / deep `#34363d` | The bottom band and lower disc on dark grounds. |
| Steel on light | `#1d1e22` / deep `#2c2d33` | The same, on light grounds. |
| Orange | `#ff8a1f` | The arrow. Never recolour it. |

These colours stay the same in every console theme. Only the steel follows the ground.

## Type

- **Wordmark:** "ROUTINI" in Barlow Semi Condensed 700, letter-spacing 0.04em.
- **Supporting line:** IBM Plex Mono, upper case, letter-spacing 0.06–0.08em.
- **Tagline:** "Your AI engineer, on call." in Barlow Semi Condensed 600.

## Rules

- Keep clear space of at least a quarter of the mark's width around it.
- Use the glyph below 40px. The full mark's disc turns to noise at small sizes.
- Don't rotate, outline or add effects (bevels, glows, textures) to the mark. Don't put it on busy photos.
- The character (the power-button figure) is a mascot for illustrations and empty states. It is not the logo.

## Regenerating

```sh
python3 brand/make_mark.py                      # SVGs (also copies the themeable ones into client/src/brand)
PLAYWRIGHT=…/playwright/index.mjs node brand/export.mjs   # PNGs, icons, social card
python3 brand/make_ico.py                       # favicon.ico (needs Pillow)
```

Change the geometry or colours in `make_mark.py`, never in the generated files.
