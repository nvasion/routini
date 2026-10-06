"""Cut the Routini logo art (brand/source) out of its paper background, with a real alpha matte.

1. Estimate the paper colour per pixel: classify obvious paper (bright, low
   saturation), replace everything else with the median paper colour, and blur
   heavily. This follows the paper's slight vignette.
2. Colour-to-alpha against that paper: alpha is how much darker than the paper
   a pixel is (max over channels), and the foreground colour is unmixed:
   F = (I - (1 - a) * B) / a. This removes the cream fringe on edges and glows.
3. Clean-up: faint circuit lines and paper shadows (alpha < ~0.12) go to 0 with
   a soft ramp. Clearly-foreground pixels keep their exact original colour at
   full opacity, so interiors are untouched.
4. Keep only the main artwork: connected components that are large (stray
   circuit-line fragments are dropped), then crop with padding.
"""
import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'source') + os.sep


def cutout(name, out, pad=24, square=False, min_area_frac=0.002, keep_box=None):
    im = np.asarray(Image.open(SRC + name).convert('RGB')).astype(np.float64)
    h, w, _ = im.shape
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    mx, mn = im.max(-1), im.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    lum = 0.299 * r + 0.587 * g + 0.114 * b

    # 1. Paper estimate.
    paper_mask = (lum > 232) & (sat < 0.10)
    median = np.median(im[paper_mask], axis=0)
    filled = np.where(paper_mask[..., None], im, median)
    paper = np.stack([ndimage.gaussian_filter(filled[..., c], 25) for c in range(3)], -1)
    paper = np.maximum(paper, 1)

    # 2. Colour-to-alpha (darker-than-paper only; brighter paper is still paper).
    a = np.clip((paper - im) / paper, 0, 1).max(-1)

    # 3. Clean-up ramp for faint lines / shadows, and solid interiors.
    lo, hi = 0.10, 0.20
    ramp = np.clip((a - lo) / (hi - lo), 0, 1)
    alpha = a * ramp
    solid = a > 0.55
    alpha = np.where(solid, 1.0, alpha)

    # 4. Main artwork only: drop small connected bits (circuit-line fragments).
    lab, n = ndimage.label(alpha > 0.05)
    if n:
        sizes = ndimage.sum(np.ones_like(alpha), lab, range(1, n + 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= min_area_frac * h * w
        if keep_box is not None:  # optionally restrict to a region of the canvas
            x0, y0, x1, y1 = keep_box
            boxmask = np.zeros_like(alpha, bool)
            boxmask[y0:y1, x0:x1] = True
            inside = ndimage.maximum(boxmask, lab, range(1, n + 1))
            keep[1:] &= np.asarray(inside, bool)
        alpha = np.where(keep[lab], alpha, 0)

    # Unmix colour where partially transparent; keep originals where solid.
    safe = np.maximum(alpha, 1e-3)[..., None]
    unmixed = np.clip((im - (1 - alpha[..., None]) * paper) / safe, 0, 255)
    rgb = np.where(solid[..., None], im, unmixed)

    rgba = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
    ys, xs = np.nonzero(alpha > 0.02)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    if square:
        side = max(x1 - x0, y1 - y0)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        x0, x1, y0, y1 = cx - side // 2, cx - side // 2 + side, cy - side // 2, cy - side // 2 + side
    canvas = Image.new('RGBA', (x1 - x0 + 2 * pad, y1 - y0 + 2 * pad), (0, 0, 0, 0))
    crop = Image.fromarray(rgba).crop((max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)))
    canvas.paste(crop, (pad + max(x0, 0) - x0, pad + max(y0, 0) - y0))
    canvas.save(out)
    print(out, canvas.size)


if __name__ == '__main__':
    o = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'art')
    os.makedirs(o, exist_ok=True)
    cutout('routini_logo.png', f'{o}/emblem.png', square=True)
    cutout('routini_title.png', f'{o}/wordmark.png')
    cutout('routini_character.png', f'{o}/character.png')
    # The banner's tagline is small text, so the speck filter drops it: mark + wordmark only.
    cutout('routini_banner_red_black.png', f'{o}/lockup.png')
    # Sized emblems; the console inlines one (its Docker build only sees client/).
    emb = Image.open(f'{o}/emblem.png')
    for s in (512, 256, 128, 64):
        emb.resize((s, s), Image.LANCZOS).save(f'{o}/emblem-{s}.png')
    client = os.path.join(HERE, '..', 'client', 'src', 'brand')
    if os.path.isdir(client):
        emb.resize((256, 256), Image.LANCZOS).save(os.path.join(client, 'emblem.png'))
        # The public pages show the art large, on its paper ground.
        emb.resize((512, 512), Image.LANCZOS).save(os.path.join(client, 'emblem-lg.png'))
        for f in ('wordmark.png', 'character.png'):
            Image.open(f'{o}/{f}').save(os.path.join(client, f))
        # WebP copies for the public pages (a fraction of the PNG size, with alpha).
        for f in ('emblem-lg.png', 'wordmark.png', 'character.png'):
            Image.open(os.path.join(client, f)).save(os.path.join(client, f.replace('.png', '.webp')), 'WEBP', quality=88, method=6)
            os.remove(os.path.join(client, f))
