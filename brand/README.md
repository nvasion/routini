# Routini brand

The logo art is the red/black emblem (`source/routini_logo.png`): a two-band loop around a glowing rising arrow. That's the routine, and automation moving it forward. The `ROUTINI` wordmark art and the character, the power-button mascot, complete the set.

## Files

| File | Use |
|---|---|
| `source/*.png` | The original art, as delivered on a paper background. These are the masters. |
| `art/emblem.png`, `art/emblem-{512,256,128,64}.png` | The emblem, cut out, transparent. This is the logo. |
| `art/wordmark.png` | The `ROUTINI` wordmark art, transparent. Light grounds only: its dark metal disappears on dark ones. |
| `art/lockup.png` | Emblem over the wordmark (with the character as the "i"). Light grounds. |
| `art/character.png` | The mascot, for illustrations and empty states. It is not the logo. |

The console's favicon, app icons, manifest and social card (`og.png`) live in `client/public/`. The header and login use `client/src/brand/emblem.png`.

## In the console

- The emblem is the mark everywhere: header (34px), login (96px), favicon and app icons. Its orange arrow keeps it readable down to favicon size on dark and light grounds.
- Next to it, "ROUTINI" is live text: Barlow Semi Condensed 700, letter-spacing 0.04em. That keeps it crisp on all three themes. The wordmark art is for light-ground marketing such as the social card and docs.
- Tagline: "Your AI engineer, on call."

## Rules

- Keep clear space of at least a quarter of the emblem's width around it.
- Use the art as delivered: don't recolour, outline, or redraw it.
- Use the wordmark and lockup art on light grounds. On dark grounds, use the emblem with the text wordmark.
- Neither the old tagline ("Algorithms. Protocols. Automation.") nor the teal "weathered" variant is used.

## Regenerating

```sh
python3 brand/cutout.py      # art/ from source/ (needs numpy, scipy, Pillow)
PLAYWRIGHT=…/playwright/index.mjs node brand/export.mjs   # icons and the social card into client/public
python3 brand/make_ico.py    # favicon.ico
```

`cutout.py` separates the art from the paper with a proper matte (colour-to-alpha against a smoothed paper estimate), so there's no cream fringe. It drops the faint circuit lines and paper shadows, and leaves the art's interiors untouched.
