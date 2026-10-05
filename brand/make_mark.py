"""Routini mark: a flat redraw of the red/black emblem.

Two tapered crescents (red sweeping over the top, steel under the bottom) form
the loop; inside, a disc split by a rising orange zigzag arrow. The full mark
keeps the inner halves and a few circuit nodes; the glyph (favicon / nav) is
just the loop and the arrow. Colours come from CSS variables with fallbacks,
so the console can theme the mark (steel goes light on dark grounds).
"""
import math, os, sys

C = 32.0


def pt(angle, r):
    a = math.radians(angle)
    return (C + r * math.cos(a), C + r * math.sin(a))


def band(a0, sweep, r_end, thick, r_start=None, taper=0.38, steps=90):
    """A swirl band: starts blunt at a0 on radius r_start (inside), spirals out to
    r_end within the first third, keeps `thick`, then tapers to a point over the
    last `taper` of the sweep. Angles clockwise (SVG), degrees."""
    r_start = r_end - thick * 0.9 if r_start is None else r_start
    outer, inner = [], []
    for i in range(steps + 1):
        u = i / steps
        a = a0 + sweep * u
        grow = min(1.0, u / 0.33)
        r_mid = r_start + (r_end - r_start) * (1 - (1 - grow) ** 2)
        t = thick if u < 1 - taper else thick * ((1 - u) / taper) ** 0.9
        outer.append(pt(a, r_mid + t / 2))
        inner.append(pt(a, r_mid - t / 2))
    f = lambda p: f"{p[0]:.2f} {p[1]:.2f}"
    return "M" + " L".join(f(p) for p in outer) + " L" + " L".join(f(p) for p in reversed(inner)) + " Z"



# The rising arrow: lower-left to upper-right, one dip on the way.
_RAW = [(17.5, 41.5), (26.5, 32.5), (32.5, 37.5), (42.5, 25.5)]
# Pulled 8% toward the centre so the head stays clear of the loop.
ARROW = [(round(C + (x - C) * 0.92, 2), round(C + (y - C) * 0.92, 2)) for x, y in _RAW]
HEAD_TIP = (46.5, 20.5)


def arrow_paths(width):
    pts = ARROW
    line = "M" + " L".join(f"{x} {y}" for x, y in pts)
    # Arrowhead: a triangle at the end, pointing along the last segment.
    (x0, y0), (x1, y1) = pts[-2], pts[-1]
    ang = math.atan2(y1 - y0, x1 - x0)
    tip = (x1 + math.cos(ang) * 6.5, y1 + math.sin(ang) * 6.5)
    left = (x1 + math.cos(ang + 2.2) * 5.2, y1 + math.sin(ang + 2.2) * 5.2)
    right = (x1 + math.cos(ang - 2.2) * 5.2, y1 + math.sin(ang - 2.2) * 5.2)
    head = f"M{tip[0]:.2f} {tip[1]:.2f} L{left[0]:.2f} {left[1]:.2f} L{right[0]:.2f} {right[1]:.2f} Z"
    return line, head, tip


RED = 'var(--mark-red, #e3261b)'
RED_DEEP = 'var(--mark-red-deep, #a11c15)'
STEEL = 'var(--mark-steel, #1d1e22)'
STEEL_DEEP = 'var(--mark-steel-deep, #2c2d33)'
ORANGE = 'var(--mark-orange, #ff8a1f)'
NODE = 'var(--mark-node, #ff8a1f)'


def mark(variant='full', fixed=None):
    c = fixed or {}
    red, red_deep, steel, steel_deep, orange, node = (c.get(k, v) for k, v in [('red', RED), ('red_deep', RED_DEEP), ('steel', STEEL), ('steel_deep', STEEL_DEEP), ('orange', ORANGE), ('node', NODE)])
    # Two bands, rotationally symmetric: each starts inside the other's tail and
    # sweeps ~200° outward, so together they read as one turning loop.
    thick = 6.4 if variant == 'full' else 7.6
    r_end = 28.2 if variant == 'full' else 28.4
    red_ring = band(128, 205, r_end, thick)
    steel_ring = band(308, 205, r_end, thick)
    line, head, tip = arrow_paths(4)
    parts = [f'<path d="{red_ring}" fill="{red}"/>', f'<path d="{steel_ring}" fill="{steel}"/>']
    if variant == 'full':
        # Inner disc split by the arrow. The gap around the arrow is a mask,
        # so whatever is behind the mark shows through (works on any ground).
        disc_r = 19.2
        seam = " L".join(f"{x} {y}" for x, y in reversed(ARROW))
        seam_fwd = " L".join(f"{x} {y}" for x, y in ARROW)
        upper = f"M0 0 H64 V18 L{seam} L0 64 Z"
        lower = f"M64 0 V64 H0 L{seam_fwd} L64 18 Z"
        parts.append(
            '<defs>'
            f'<clipPath id="rq-disc"><circle cx="32" cy="32" r="{disc_r}"/></clipPath>'
            '<mask id="rq-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            '<rect width="64" height="64" fill="#fff"/>'
            f'<path d="{line}" fill="none" stroke="#000" stroke-width="8.5" stroke-linejoin="round" stroke-linecap="round"/>'
            f'<path d="{head}" fill="#000" stroke="#000" stroke-width="4.5" stroke-linejoin="round"/>'
            '</mask>'
            '</defs>'
            f'<g clip-path="url(#rq-disc)" mask="url(#rq-gap)">'
            f'<path d="{upper}" fill="{red_deep}"/><path d="{lower}" fill="{steel_deep}"/>'
            '</g>'
        )
    w = 4.2 if variant == 'full' else 5.2
    parts.append(f'<path d="{line}" fill="none" stroke="{orange}" stroke-width="{w}" stroke-linejoin="round" stroke-linecap="round"/>')
    parts.append(f'<path d="{head}" fill="{orange}" stroke="{orange}" stroke-width="1.5" stroke-linejoin="round"/>')
    return "".join(parts)


def svg(body, view='0 0 64 64', w=None, h=None, extra=''):
    size = f' width="{w}" height="{h}"' if w else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}"{size}{extra}>{body}</svg>\n'


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'svg')
    open(f'{out}/mark.svg', 'w').write(svg(mark('full'), extra=' role="img" aria-label="Routini"'))
    open(f'{out}/mark-glyph.svg', 'w').write(svg(mark('glyph'), extra=' role="img" aria-label="Routini"'))
    # Favicon: the glyph; steel follows the tab bar (light/dark).
    fav = (
        '<style>.s{fill:#1d1e22}@media (prefers-color-scheme: dark){.s{fill:#9a9ea8}}</style>'
        + mark('glyph', {'red': '#e3261b', 'steel': 'STEEL', 'orange': '#ff8a1f'}).replace('fill="STEEL"', 'class="s"')
    )
    open(f'{out}/favicon.svg', 'w').write(svg(fav))
    # Fixed-colour marks for raster exports (dark ground and light ground).
    dark = {'red': '#e3261b', 'red_deep': '#a11c15', 'steel': '#8d919b', 'steel_deep': '#34363d', 'orange': '#ff8a1f', 'node': '#ffb366'}
    light = {'red': '#e3261b', 'red_deep': '#a11c15', 'steel': '#1d1e22', 'steel_deep': '#2c2d33', 'orange': '#ff8a1f', 'node': '#ff8a1f'}
    open(f'{out}/mark-on-dark.svg', 'w').write(svg(mark('full', dark)))
    open(f'{out}/mark-on-light.svg', 'w').write(svg(mark('full', light)))
    open(f'{out}/glyph-on-dark.svg', 'w').write(svg(mark('glyph', dark)))
    open(f'{out}/glyph-on-light.svg', 'w').write(svg(mark('glyph', light)))
    # The console inlines the themeable marks (its Docker build only sees client/).
    client = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'client', 'src', 'brand')
    if os.path.isdir(client):
        for f in ('mark.svg', 'mark-glyph.svg'):
            open(os.path.join(client, f), 'w').write(open(os.path.join(out, f)).read())
    print('ok')
