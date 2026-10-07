// ─────────────────────────────────────────────────────────────────────────────
// Where a step executes. Each executor emits one `step.placement` event as the
// attempt starts, so the timeline can say "ran on web-1 via routini-runner"
// instead of leaving it to the logs.
//
//   fleet    one of the org's hosts (via routini-runner or SSH)
//   sandbox  an agent container on Routini's Docker host (routini-agents)
//   routini  the Routini worker itself (http, imap, azure-boards, teams)
//   factory  dispatched to Factory, which runs it on its own infrastructure
// ─────────────────────────────────────────────────────────────────────────────

import type { StepContext } from './types.js'

export interface Placement {
  target: 'fleet' | 'sandbox' | 'routini' | 'factory'
  /** Host (or Docker host) name, as shown to the user. */
  host: string
  via?: 'runner' | 'ssh'
  hostId?: string
  /** Persistent environment the agent ran in, if any. */
  environment?: string
}

export const PLACEMENT_EVENT = 'step.placement'

export function emitPlacement(ctx: StepContext, p: Placement): Promise<void> {
  return ctx.emit(PLACEMENT_EVENT, { ...p })
}
