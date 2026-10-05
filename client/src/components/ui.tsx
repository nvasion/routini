// Small shared UI pieces. Styling lives in styles/app.css.

import { useEffect, useId, useRef, type ReactNode, type SVGProps } from 'react'
import type { RunStatus, StepStatus } from '../lib/types'
import { runStatusLabel } from '../lib/format'

// ── Icons (inline stroke SVG, currentColor) ──────────────────────────────────

const PATHS = {
  inbox: 'M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z',
  runs: 'M3 12h4l3-8 4 16 3-8h4',
  jobs: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  plug: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
  live: 'M2 12h3l3-7 4 14 3-7h7',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  collapse: 'M6 6l6 6-6 6M13 6l6 6-6 6',
  chevron: 'M6 9l6 6 6-6',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5l12 7-12 7z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
} as const
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  )
}

// ── Status ───────────────────────────────────────────────────────────────────

export function StatusDot({ status, label }: { status: RunStatus | StepStatus | 'ok' | 'warn' | 'fail' | 'off' | 'live'; label?: string }) {
  const pulsing = status === 'running' || status === 'live'
  return <span className={`dot ${status}${pulsing ? ' pulse' : ''}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}

export function RunBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge ${status}`}>
      <StatusDot status={status} />
      {runStatusLabel(status)}
    </span>
  )
}

// ── Forms ────────────────────────────────────────────────────────────────────

export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode; id?: string }) {
  const auto = useId()
  const fid = id ?? auto
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      {children(fid)}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

export function ErrorBanner({ error }: { error: string | null | undefined }) {
  if (!error) return null
  return (
    <div className="banner" role="alert">
      {error}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn icon" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Meter({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="meter">
      <span style={{ width: 36 }} className="muted">
        {label}
      </span>
      <span className="track">
        <span className={`fill${pct >= 85 ? ' high' : ''}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="mono" style={{ width: 40, textAlign: 'right' }}>
        {pct}%
      </span>
    </div>
  )
}
