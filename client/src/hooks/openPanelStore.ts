/**
 * openPanelStore — plain-JS external store backing useOpenPanel.
 *
 * Coordinates a single, dashboard-wide "which task's configuration panel is
 * open" flag so that at most one TaskConfigPanel is expanded at any time, no
 * matter how many TaskCard instances are mounted.
 *
 * Why a module-level external store instead of React Context?
 *  - Context would require a <Provider> wrapping the component tree (e.g. in
 *    App.tsx or Dashboard.tsx), which TaskCard is not responsible for.
 *  - A module-scoped store works with zero wiring: every TaskCard subscribes
 *    independently (see useOpenPanel.ts) and stays in sync automatically.
 *
 * Kept free of any React import so this state machine — the "only one panel
 * open at a time" invariant — can be unit-tested directly, without needing a
 * component-rendering test harness.
 */

let openTaskId: string | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Registers a listener invoked whenever the open panel changes; returns an unsubscribe function. */
export function subscribeOpenPanel(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Returns the ID of the task whose panel is currently open, or null if none is open. */
export function getOpenPanelId(): string | null {
  return openTaskId
}

/** Opens the panel for `taskId`, implicitly closing whichever other panel was open. No-op if already open. */
export function openPanel(taskId: string): void {
  if (openTaskId === taskId) return
  openTaskId = taskId
  notify()
}

/** Closes the panel for `taskId`. No-op if a different (or no) panel is currently open. */
export function closePanel(taskId: string): void {
  if (openTaskId !== taskId) return
  openTaskId = null
  notify()
}

/** Opens `taskId`'s panel if closed, closes it if already open. */
export function togglePanel(taskId: string): void {
  if (openTaskId === taskId) closePanel(taskId)
  else openPanel(taskId)
}

/**
 * Test-only reset so unrelated test files don't leak open-panel state
 * between runs (the store is a module-level singleton for the lifetime of
 * the JS runtime).
 */
export function resetOpenPanelForTests(): void {
  openTaskId = null
  listeners.clear()
}
