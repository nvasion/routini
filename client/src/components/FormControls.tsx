/**
 * Small presentational pieces shared by every modal that reuses the
 * ConfigModal overlay/panel chrome (see ConfigModal.css for the `cm-*`
 * classes these render into). Split out of ConfigModal.tsx so new modals —
 * e.g. IntegrationConnectModal — can reuse the same label/hint/status
 * layout instead of re-implementing it.
 */

import type { ReactNode } from 'react'

export function FormRow({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="cm-form-row">
      <label htmlFor={id} className="cm-form-label">
        {label}
      </label>
      {children}
      {hint && <p className="cm-form-hint">{hint}</p>}
    </div>
  )
}

export function FormStatus({ error, saved }: { error: string | null; saved: boolean }) {
  if (error) return <p className="cm-error" role="alert">{error}</p>
  if (saved) return <p className="cm-success" role="status">Saved</p>
  return null
}
