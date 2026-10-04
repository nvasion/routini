// Display helpers. Pure functions; tested in format.test.ts.

import type { RunStatus, StepStatus } from './types'

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const diff = new Date(iso).getTime() - now
  const abs = Math.abs(diff)
  const future = diff > 0
  const fmt = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`)
  if (abs < 45_000) return future ? 'in a moment' : 'just now'
  if (abs < 3_600_000) return fmt(Math.round(abs / 60_000), 'm')
  if (abs < 86_400_000) return fmt(Math.round(abs / 3_600_000), 'h')
  return fmt(Math.round(abs / 86_400_000), 'd')
}

export function duration(startIso: string | null, endIso: string | null, now: number = Date.now()): string {
  if (!startIso) return '—'
  const ms = (endIso ? new Date(endIso).getTime() : now) - new Date(startIso).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function money(usd: number): string {
  if (!usd) return '$0'
  return usd < 1 ? `$${usd.toFixed(usd < 0.01 ? 4 : 2)}` : `$${usd.toFixed(2)}`
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const RUN_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting on you',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
}
export const runStatusLabel = (s: RunStatus) => RUN_LABELS[s] ?? s

const STEP_LABELS: Record<StepStatus, string> = {
  pending: 'pending',
  running: 'running',
  waiting: 'waiting for approval',
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  canceled: 'canceled',
}
export const stepStatusLabel = (s: StepStatus) => STEP_LABELS[s] ?? s

export const isLive = (s: RunStatus) => s === 'queued' || s === 'running'

export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes('@') ? nameOrEmail.split('@')[0]! : nameOrEmail
  const parts = base.split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function describeTrigger(t: { kind: string; expr?: string; tz?: string }): string {
  if (t.kind === 'cron') return `cron ${t.expr}${t.tz && t.tz !== 'UTC' ? ` (${t.tz})` : ''}`
  if (t.kind === 'webhook') return 'webhook'
  return 'manual'
}
