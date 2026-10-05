// The Routini mark, inlined so it follows the theme (--mark-* tokens).
// `full` keeps the split disc (use from ~40px up); `glyph` is just the loop and
// the arrow, for the header, favicons and anything small.
// Source: brand/make_mark.py (regenerate there, never edit these SVGs by hand).

import markSvg from '../brand/mark.svg?raw'
import glyphSvg from '../brand/mark-glyph.svg?raw'

export function Mark({ size = 32, variant = 'full', label }: { size?: number; variant?: 'full' | 'glyph'; label?: string }) {
  return (
    <span
      className="mark"
      style={{ width: size, height: size }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      dangerouslySetInnerHTML={{ __html: variant === 'full' ? markSvg : glyphSvg }}
    />
  )
}

/** Mark + wordmark, with an optional line under the name. */
export function Lockup({ size = 32, variant = 'glyph', sub }: { size?: number; variant?: 'full' | 'glyph'; sub?: string }) {
  return (
    <span className="lockup">
      <Mark size={size} variant={variant} />
      <span className="lockup-text">
        <span className="brand-name" style={{ fontSize: Math.round(size * 0.66) }}>
          ROUTINI
        </span>
        {sub && <span className="brand-sub">{sub}</span>}
      </span>
    </span>
  )
}
