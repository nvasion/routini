/**
 * Pure helpers for ConfigModal, split into their own module so they can be
 * unit-tested without pulling in React/JSX or the modal's CSS import.
 */

import type { DailyActionType } from '../types'

/** A single editable key/value row in the daily-task "Config" editor. */
export interface ConfigRow {
  key: string
  value: string
}

export const DAILY_ACTION_TYPES: DailyActionType[] = ['ssh', 'email', 'http']

/** Known AI agents a developmental task can be assigned to (mirrors server/src/services/devTask.ts VALID_AGENTS). */
export const AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'omnimancer', label: 'Omnimancer' },
]

/**
 * Converts editable config key/value rows into a plain record, ready to send
 * to the server.
 *
 *  - Rows with a blank (or whitespace-only) key are skipped — they represent
 *    an unfinished "add another row" the user never filled in.
 *  - Keys and values are trimmed.
 *  - When the same key appears twice, the later row wins (matches normal
 *    object-literal semantics, and lets a user "overwrite" an earlier typo
 *    by adding a corrected row below it).
 */
export function configRowsToRecord(rows: ConfigRow[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    record[key] = row.value.trim()
  }
  return record
}

export interface DailyFormValues {
  name: string
  description: string
  schedule: string
  actionType: DailyActionType
  configRows: ConfigRow[]
}

/** Returns a validation error message, or null when the form is valid. */
export function validateDailyForm(values: DailyFormValues): string | null {
  if (!values.name.trim()) return 'Name is required'
  if (!values.schedule.trim()) return 'Schedule is required'
  if (!DAILY_ACTION_TYPES.includes(values.actionType)) {
    return `Action type must be one of: ${DAILY_ACTION_TYPES.join(', ')}`
  }
  return null
}

/**
 * Builds the PUT /api/tasks/:id request body for a daily task.
 *
 * `config` is only included when the user actually entered at least one
 * key/value row. The server never sends existing config values to the
 * browser (they may hold credentials — see sanitizeTaskForClient), so an
 * empty edit means "leave it alone" rather than "clear it"; including an
 * empty object here would silently wipe out whatever secret configuration
 * is already stored.
 */
export function buildDailyUpdatePayload(values: DailyFormValues): Record<string, unknown> {
  const configRecord = configRowsToRecord(values.configRows)
  return {
    name: values.name.trim(),
    description: values.description.trim(),
    schedule: values.schedule.trim(),
    actionType: values.actionType,
    ...(Object.keys(configRecord).length > 0 ? { config: configRecord } : {}),
  }
}

export interface DevFormValues {
  name: string
  description: string
  repoUrl: string
  branch: string
  agentId: string
}

export function validateDevForm(values: DevFormValues): string | null {
  if (!values.name.trim()) return 'Name is required'
  if (!values.repoUrl.trim()) return 'Repository URL is required'
  if (!values.branch.trim()) return 'Branch is required'
  if (!values.agentId.trim()) return 'Agent is required'
  return null
}

export function buildDevUpdatePayload(values: DevFormValues): Record<string, unknown> {
  return {
    name: values.name.trim(),
    description: values.description.trim(),
    repoUrl: values.repoUrl.trim(),
    branch: values.branch.trim(),
    agentId: values.agentId.trim(),
  }
}

export interface MetaFormValues {
  name: string
  description: string
}

/** Validation for the routine name/description mini-form. */
export function validateMetaForm(values: MetaFormValues): string | null {
  if (!values.name.trim()) return 'Name is required'
  return null
}

export function buildMetaUpdatePayload(values: MetaFormValues): Record<string, unknown> {
  return {
    name: values.name.trim(),
    description: values.description.trim(),
  }
}
