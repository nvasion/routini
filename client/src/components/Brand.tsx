// The Routini emblem (the logo art, cut out: brand/cutout.py) and the lockup
// used in the header. The wordmark next to it is live text in the brand font,
// so it stays crisp and readable on every theme.

import emblemUrl from '../brand/emblem.png'

export function Mark({ size = 32, label }: { size?: number; label?: string }) {
  return <img className="mark" src={emblemUrl} width={size} height={size} alt={label ?? ''} aria-hidden={label ? undefined : true} draggable={false} />
}

/** Emblem + wordmark, with an optional line under the name. */
export function Lockup({ size = 32, sub }: { size?: number; sub?: string }) {
  return (
    <span className="lockup">
      <Mark size={size} />
      <span className="lockup-text">
        <span className="brand-name" style={{ fontSize: Math.round(size * 0.62) }}>
          ROUTINI
        </span>
        {sub && <span className="brand-sub">{sub}</span>}
      </span>
    </span>
  )
}
