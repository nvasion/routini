// ─────────────────────────────────────────────────────────────────────────────
// Source adapter registry. Contract: docs/work-intake-backlog.md sections 6 and 6b.
// ─────────────────────────────────────────────────────────────────────────────

import { azureBoardsAdapter } from './azureBoards.js'
import { githubIssuesAdapter } from './githubIssues.js'
import { jiraAdapter } from './jira.js'
import { linearAdapter } from './linear.js'
import { mondayAdapter } from './monday.js'
import { repoAdapter } from './repo.js'
import type { SourceAdapter, SourceKind } from './types.js'

const ADAPTERS: Record<SourceKind, SourceAdapter> = {
  monday: mondayAdapter,
  repo: repoAdapter,
  jira: jiraAdapter,
  linear: linearAdapter,
  'azure-boards': azureBoardsAdapter,
  'github-issues': githubIssuesAdapter,
}

/** Returns the pure adapter for a backlog source kind. */
export function getAdapter(kind: SourceKind): SourceAdapter {
  const adapter = ADAPTERS[kind]
  if (!adapter) throw new Error(`Unknown backlog source kind: ${String(kind)}`)
  return adapter
}

export { azureBoardsAdapter } from './azureBoards.js'
export { githubIssuesAdapter } from './githubIssues.js'
export { jiraAdapter } from './jira.js'
export { linearAdapter } from './linear.js'
export { mondayAdapter } from './monday.js'
export { repoAdapter } from './repo.js'
