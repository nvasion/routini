/**
 * Pure helpers for IntegrationConnectionPanel, split into their own module so
 * they can be unit-tested without pulling in React/JSX or CSS imports —
 * mirrors the split already used by configModal.utils.ts.
 */

import type { AIProvider, IntegrationScopes, TaskType } from '../types'

/** Every task type a scoping panel can allow/deny (mirrors client/src/types.ts TaskType). */
export const TASK_TYPE_OPTIONS: { value: TaskType; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'developmental', label: 'Developmental' },
  { value: 'routine', label: 'Routine' },
]

/** Every coding agent a scoping panel can allow/deny (mirrors client/src/types.ts AIProvider). */
export const AGENT_SCOPE_OPTIONS: { value: AIProvider; label: string }[] = [
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'omnimancer', label: 'Omnimancer' },
]

/** The "default all" scopes a newly-connected integration starts with (PRD: "default all"). */
export function defaultScopes(): IntegrationScopes {
  return {
    taskTypes: TASK_TYPE_OPTIONS.map(o => o.value),
    agents: AGENT_SCOPE_OPTIONS.map(o => o.value),
  }
}

/**
 * Toggles `value`'s membership in `list`, returning a new array. Used by the
 * scoping panel's checkboxes for both task types and agents.
 */
export function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value]
}

/** Builds the PUT /api/integrations/:id request body for a scoping-only update. */
export function buildScopesPayload(scopes: IntegrationScopes): { scopes: IntegrationScopes } {
  return { scopes }
}

/**
 * Formats an ISO timestamp for display, or a placeholder when the
 * integration has never been tested/connected. Wrapped in a helper (rather
 * than inlining `new Date(...).toLocaleString()`) so tests can assert
 * behavior for the null case without depending on the host's locale.
 */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString()
}

/** Human-readable summary of the most recent Test connection result. */
export function describeTestResult(lastTestOk: boolean | null, lastTestAt: string | null): string {
  if (lastTestOk === null || !lastTestAt) return 'Not tested yet'
  return lastTestOk
    ? `Connection OK — last tested ${formatTimestamp(lastTestAt)}`
    : `Connection failed — last tested ${formatTimestamp(lastTestAt)}`
}
