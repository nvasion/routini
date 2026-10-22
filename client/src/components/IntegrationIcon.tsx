import factoryMark from '../brand/integrations/factory.png'
import { INTEGRATION_ICONS } from './integrationIcons'

/** An integration's mark on a neutral tile; falls back to its initials. */
export function IntegrationIcon({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
  const icon = INTEGRATION_ICONS[id]
  const glyph = Math.round(size * 0.56)
  let mark
  if (icon) {
    mark = (
      <svg viewBox={icon.viewBox} width={glyph} height={glyph} fill="currentColor" aria-hidden="true" focusable="false">
        {icon.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    )
  } else if (id === 'factory') {
    // The PNG's alpha is the shape; the tile's ink fills it, so it stays monochrome.
    const mask = `url(${factoryMark}) center / contain no-repeat`
    mark = <span aria-hidden="true" style={{ width: glyph, height: glyph, background: 'currentColor', mask, WebkitMask: mask }} />
  } else {
    mark = (
      <span aria-hidden="true" style={{ fontFamily: 'var(--font-mono)', fontSize: Math.round(size * 0.36), fontWeight: 600 }}>
        {initials(name)}
      </span>
    )
  }
  return (
    <span className="integration-icon" style={{ width: size, height: size }} data-integration={id}>
      {mark}
    </span>
  )
}

/** "ttyy.ai" → "TT", "Microsoft Teams" → "MT". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.trim().slice(0, 2)).toUpperCase() || '?'
}
