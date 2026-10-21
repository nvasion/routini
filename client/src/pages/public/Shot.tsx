// A screenshot of the real console, framed like a browser window. Each shot
// exists once per theme (src/assets/shots/<name>-routini|light|dark.webp, made
// by scripts/shots.sh); CSS shows the one that matches the theme, and lazy
// loading means the hidden ones are never fetched.

const SHOTS = import.meta.glob<string>('../../assets/shots/*.webp', { eager: true, import: 'default' })

const VARIANTS = ['routini', 'light', 'dark'] as const

function shotUrl(name: string, variant: string): string | undefined {
  return SHOTS[`../../assets/shots/${name}-${variant}.webp`]
}

export function Shot({ name, alt, path }: { name: string; alt: string; path: string }) {
  // A missing capture falls back to the Routini one, so a new theme never shows a hole.
  const fallback = shotUrl(name, 'routini')
  return (
    <figure className="shot">
      <div className="shot-bar" aria-hidden="true">
        <span className="shot-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="shot-url">routini.tynhub.com{path}</span>
      </div>
      {fallback ? (
        VARIANTS.map((v) => (
          <img key={v} className={`shot-img shot-${v}`} src={shotUrl(name, v) ?? fallback} alt={alt} loading="lazy" width={1440} height={900} />
        ))
      ) : (
        <div className="shot-missing" role="img" aria-label={alt} />
      )}
    </figure>
  )
}
