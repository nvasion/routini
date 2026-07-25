/**
 * Pure helpers for TaskConfigPanel, split into their own module so they can
 * be unit-tested without pulling in React/JSX or the panel's CSS import.
 */

/**
 * Formats a DevTask's `lastRunAt` timestamp for display.
 *  - Missing/empty value  → "Never" (the task has not run yet).
 *  - Unparseable string   → returned verbatim so the raw value is still
 *    visible to the user rather than silently hidden.
 *  - Valid ISO timestamp  → localized date/time string.
 */
export function formatLastRun(lastRunAt?: string): string {
  if (!lastRunAt || !lastRunAt.trim()) return 'Never'
  const parsed = new Date(lastRunAt)
  if (Number.isNaN(parsed.getTime())) return lastRunAt
  return parsed.toLocaleString()
}

/**
 * Safely extracts [key, value] pairs from a DailyTask's `config` map for
 * display. The server strips `config` from every task it sends to the
 * client (it may hold SSH/HTTP/email credentials), so callers will usually
 * see `undefined` here — this helper degrades to an empty list rather than
 * throwing when that's the case.
 */
export function getConfigEntries(config: Record<string, string> | undefined | null): [string, string][] {
  if (!config || typeof config !== 'object') return []
  return Object.entries(config)
}
