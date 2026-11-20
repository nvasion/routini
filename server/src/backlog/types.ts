// ─────────────────────────────────────────────────────────────────────────────
// Backlog types shared by the repository (repos/backlog.ts), the source
// adapters (backlog/*.ts), sync and the routes. Contract: docs/work-intake-backlog.md.
// ─────────────────────────────────────────────────────────────────────────────

import type { FetchFn } from '../integrations/providers.js'

/** Routini's own state for every item, mapped per source in both directions. */
export type ItemState = 'ready' | 'planning' | 'building' | 'finishing' | 'done' | 'blocked' | 'dropped'
export const ITEM_STATES: readonly ItemState[] = ['ready', 'planning', 'building', 'finishing', 'done', 'blocked', 'dropped']

/** How a source's own status values map to and from Routini's states. */
export interface StatusMapping {
  /** Written to the source when the item enters the state; states without an entry are not written. */
  out: Partial<Record<ItemState, { value: string; comment?: boolean }>>
  /** Source values (case-insensitive prefix match) that mean ready or dropped. */
  in: { ready: string[]; dropped: string[] }
}

/** One item as a source reports it. */
export interface SourceItem {
  externalId: string
  title: string
  body: string
  url: string | null
  /** The source's own status value, as is. */
  state: string
  labels: string[]
  repoUrl?: string | null
  baseBranch?: string | null
  position?: number | null
}

export interface AdapterCtx {
  fetch: FetchFn
  /** The org's credentials for an integration (empty when not connected). */
  credentials(integration: 'monday' | 'github'): Promise<Record<string, string>>
  signal?: AbortSignal
}

export interface StatusWrite {
  value: string
  comment?: string
}

export interface SourceAdapter<C = unknown> {
  kind: 'monday' | 'repo'
  integration: 'monday' | 'github'
  /** Validates a source's config; throws SpecError naming the exact field. */
  parseConfig(raw: unknown): C
  /** At most 500 items. */
  fetch(ctx: AdapterCtx, cfg: C): Promise<SourceItem[]>
  write(ctx: AdapterCtx, cfg: C, item: { externalId: string; title: string; url: string | null }, w: StatusWrite): Promise<void>
}
