// ─────────────────────────────────────────────────────────────────────────────
// Agent returns: typed fields an agent step writes to $ROUTINI_OUT_FILE as one
// JSON object, surfaced to later steps as `{{steps.<id>.out.<name>}}`.
//
//   availableChoices  – a choice field's choices with any `requires` an
//                        unconnected integration dropped.
//   promptForReturns  – the sentence appended to ROUTINI_SYSTEM_PROMPT, and the
//                        fields with their choices resolved; fails before the
//                        step starts if a choice field has nothing left.
//   validateReturns   – checks the agent's parsed JSON object against the
//                        fields (after `promptForReturns` has resolved them).
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import { listIntegrationStates } from '../repos/integrations.js'
import type { ReturnField } from './spec.js'

const MAX_TEXT = 20_000

/** The choices still offered for `field`, after dropping ones whose `requires` integration is not connected. */
export async function availableChoices(q: Queryable, orgId: string, field: ReturnField): Promise<NonNullable<ReturnField['choices']>> {
  const choices = field.choices ?? []
  if (!choices.some((c) => c.requires)) return choices
  const states = await listIntegrationStates(q, orgId)
  return choices.filter((c) => !c.requires || !!states.get(c.requires)?.connectedAt)
}

function describeField(f: ReturnField): string {
  const kind = f.type === 'choice' ? `choice, one of: ${f.choices!.map((c) => c.value).join(' | ')}` : f.type
  return `${f.name} (${kind})${f.description ? ` - ${f.description}` : ''}`
}

/**
 * Resolves each choice field's available choices for the org, and the
 * sentence to append to the agent's system prompt. Fails before the step
 * starts if a choice field ends up with nothing to offer.
 */
export async function promptForReturns(q: Queryable, orgId: string, fields: ReturnField[]): Promise<{ prompt: string; fields: ReturnField[] } | { error: string }> {
  const resolved: ReturnField[] = []
  for (const f of fields) {
    if (f.type !== 'choice') {
      resolved.push(f)
      continue
    }
    const choices = await availableChoices(q, orgId, f)
    if (choices.length === 0) {
      const needs = [...new Set((f.choices ?? []).map((c) => c.requires).filter((x): x is string => !!x))]
      return { error: `Field ${f.name} has no available choices (needs: ${needs.join(', ')})` }
    }
    resolved.push({ ...f, choices })
  }
  const prompt = `Before you finish, write one JSON object to $ROUTINI_OUT_FILE with these fields: ${resolved.map(describeField).join('; ')}.`
  return { prompt, fields: resolved }
}

/**
 * Validates the agent's parsed output object against `fields` (the ones
 * `promptForReturns` resolved: unavailable choices already dropped). Unknown
 * keys in `raw` are silently dropped from the result.
 */
export function validateReturns(fields: ReturnField[], raw: unknown): { out: Record<string, unknown> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The agent did not write a JSON object to $ROUTINI_OUT_FILE' }
  const obj = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = obj[f.name]
    if (v === undefined || v === null) {
      if (f.required !== false) return { error: `The agent's output is missing ${f.name}` }
      continue
    }
    switch (f.type) {
      case 'text':
        if (typeof v !== 'string') return { error: `${f.name} must be a ${f.type}` }
        if (v.length > MAX_TEXT) return { error: `${f.name} must be at most ${MAX_TEXT} characters` }
        out[f.name] = v
        break
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${f.name} must be a ${f.type}` }
        out[f.name] = v
        break
      case 'boolean':
        if (typeof v !== 'boolean') return { error: `${f.name} must be a ${f.type}` }
        out[f.name] = v
        break
      case 'choice': {
        const values = (f.choices ?? []).map((c) => c.value)
        if (typeof v !== 'string' || !values.includes(v)) return { error: `${f.name} must be one of: ${values.join(', ')} (got '${String(v)}')` }
        out[f.name] = v
        break
      }
    }
  }
  return { out }
}
