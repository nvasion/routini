/**
 * Pure helpers for IntegrationConnectModal, split into their own module so
 * they can be unit-tested without pulling in React/JSX or the modal's CSS
 * (mirrors the split used for ConfigModal in configModal.utils.ts).
 */

import type { Integration } from '../types'

/** Builds the initial (always-blank) field values for a connect form. Every
 * credential field is write-only — the server never echoes a stored value
 * back to the client (see Integration in ../types) — so re-opening the modal
 * for an already-connected integration must not attempt to pre-fill secrets.
 */
export function initialFieldValues(integration: Integration): Record<string, string> {
  return Object.fromEntries(integration.fields.map(field => [field.key, '']))
}

/**
 * Returns a validation error message, or null when the form is ready to submit.
 *
 *  - First-time connect (status !== 'connected'): every `required` field must
 *    have a non-blank value.
 *  - Editing an already-connected integration: fields may be left blank to
 *    keep their stored value unchanged (write-only, so the client can't tell
 *    which ones already hold something) — but at least one field must be
 *    filled in, otherwise the save would be a silent no-op.
 */
export function validateConnectForm(integration: Integration, values: Record<string, string>): string | null {
  if (integration.status === 'connected') {
    const anyFilled = integration.fields.some(field => (values[field.key] ?? '').trim().length > 0)
    return anyFilled ? null : 'Enter at least one field to update'
  }

  const missing = integration.fields.filter(field => field.required && !(values[field.key] ?? '').trim())
  if (missing.length === 0) return null
  const verb = missing.length > 1 ? 'are' : 'is'
  return `${missing.map(field => field.label).join(', ')} ${verb} required`
}

/**
 * Builds the PUT /api/integrations/:id request body. Only fields the user
 * actually filled in are included — blank fields are omitted rather than
 * sent as empty strings, so they leave whatever is already stored untouched
 * (same "blank means don't change it" semantics as the daily-task config
 * editor and the AI-settings API key field).
 */
export function buildConnectPayload(values: Record<string, string>): Record<string, string> {
  const payload: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim()
    if (trimmed) payload[key] = trimmed
  }
  return payload
}
