// ─────────────────────────────────────────────────────────────────────────────
// Source adapter registry. Contract: docs/work-intake-backlog.md section 6.
// ─────────────────────────────────────────────────────────────────────────────

import { mondayAdapter } from './monday.js'
import { repoAdapter } from './repo.js'
import type { SourceAdapter } from './types.js'

/** Returns the pure adapter for a backlog source kind. */
export function getAdapter(kind: 'monday' | 'repo'): SourceAdapter {
  switch (kind) {
    case 'monday':
      return mondayAdapter
    case 'repo':
      return repoAdapter
    default: {
      const exhaustive: never = kind
      throw new Error(`Unknown backlog source kind: ${String(exhaustive)}`)
    }
  }
}

export { mondayAdapter } from './monday.js'
export { repoAdapter } from './repo.js'
