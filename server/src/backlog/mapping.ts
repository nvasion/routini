// ─────────────────────────────────────────────────────────────────────────────
// Status mapping: how a source's own status values map to and from Routini's
// item states. Contract: docs/work-intake-backlog.md section 6.
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import { ITEM_STATES, type ItemState, type StatusMapping } from './types.js'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** States whose written value, if read back, would immediately look "ready" again. */
const LOOP_RISK_STATES: readonly ItemState[] = ['planning', 'building', 'finishing', 'done', 'blocked']

/** True when `external` starts with any of `list`, case-insensitively (e.g. "Planned (2026-11-11)" matches "Planned"). */
export function matchesAny(external: string, list: readonly string[]): boolean {
  const lower = external.toLowerCase()
  return list.some((candidate) => lower.startsWith(candidate.toLowerCase()))
}

function parseOut(raw: unknown): StatusMapping['out'] {
  if (raw === undefined) return {}
  if (!isObj(raw)) throw new SpecError('mapping.out must be an object')
  const out: StatusMapping['out'] = {}
  for (const [state, entryRaw] of Object.entries(raw)) {
    if (!(ITEM_STATES as readonly string[]).includes(state)) {
      throw new SpecError(`mapping.out.${state} is not a valid state`)
    }
    if (!isObj(entryRaw)) throw new SpecError(`mapping.out.${state} must be an object`)
    const value = entryRaw['value']
    if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
      throw new SpecError(`mapping.out.${state}.value must be a string of 1-100 characters`)
    }
    const comment = entryRaw['comment']
    if (comment !== undefined && typeof comment !== 'boolean') {
      throw new SpecError(`mapping.out.${state}.comment must be a boolean`)
    }
    out[state as ItemState] = comment === undefined ? { value } : { value, comment }
  }
  return out
}

function parseStringList(raw: unknown, path: string, min: number, max: number): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    throw new SpecError(`${path} must be a list of ${min}-${max} strings`)
  }
  const values = raw.map((v, idx) => {
    if (typeof v !== 'string' || v.length < 1 || v.length > 60) {
      throw new SpecError(`${path}[${idx}] must be a string of 1-60 characters`)
    }
    return v
  })
  return values
}

/** Parses and validates a source's status mapping; throws SpecError naming the exact field. */
export function parseMapping(raw: unknown): StatusMapping {
  if (!isObj(raw)) throw new SpecError('mapping must be an object')

  const out = parseOut(raw['out'])

  const inRaw = raw['in']
  if (!isObj(inRaw)) throw new SpecError('mapping.in must be an object')
  const ready = parseStringList(inRaw['ready'], 'mapping.in.ready', 1, 20)
  const dropped = inRaw['dropped'] === undefined ? [] : parseStringList(inRaw['dropped'], 'mapping.in.dropped', 0, 20)

  for (const state of LOOP_RISK_STATES) {
    const entry = out[state]
    if (entry && matchesAny(entry.value, ready)) {
      throw new SpecError(`'${entry.value}' is written for ${state} and read as ready; items would loop`)
    }
  }

  return { out, in: { ready, dropped } }
}
