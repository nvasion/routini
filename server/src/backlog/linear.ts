// ─────────────────────────────────────────────────────────────────────────────
// Linear backlog source. Contract: docs/work-intake-backlog.md section 6b.
// Placeholder: the work intake P4 task for Linear replaces this file.
// ─────────────────────────────────────────────────────────────────────────────

import { SpecError } from '../engine/spec.js'
import type { SourceAdapter } from './types.js'

const NOT_YET = 'Linear sources are not available yet'

export const linearAdapter: SourceAdapter = {
  kind: 'linear',
  integration: 'linear',
  parseConfig() {
    throw new SpecError(NOT_YET)
  },
  async fetch() {
    throw new Error(NOT_YET)
  },
  async write() {
    throw new Error(NOT_YET)
  },
}
