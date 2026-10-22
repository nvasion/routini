// Images a fleet host (routini-runner) pulls: agent images for `runOn` steps,
// images environments on a host may use, and the egress proxy beside them.
// Separate from the sandbox's images: a runner pulls from a public registry,
// while the sandbox may use a local build. Its own module so agent.ts and
// environments.ts can both use it without importing each other.

import type { AgentId } from '../integrations/catalog.js'

/** Image per agent on a fleet host. */
export function fleetAgentImages(env: NodeJS.ProcessEnv = process.env): Partial<Record<AgentId, string>> {
  return {
    claude: env['ROUTINI_FLEET_AGENT_IMAGE_CLAUDE'] || 'ghcr.io/nvasion/routini-agent-claude:latest',
    omnimancer: env['ROUTINI_FLEET_AGENT_IMAGE_OMNIMANCER'] || undefined,
    opencode: env['ROUTINI_FLEET_AGENT_IMAGE_OPENCODE'] || undefined,
  }
}

/**
 * Images an environment on a fleet host may use: ROUTINI_FLEET_ENV_IMAGES
 * (comma list), else the configured fleet agent images.
 */
export function fleetEnvImages(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env['ROUTINI_FLEET_ENV_IMAGES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return configured.length ? configured : Object.values(fleetAgentImages(env)).filter((v): v is string => Boolean(v))
}

/** The egress proxy a fleet host runs beside agent and environment containers. */
export function fleetEgressImage(env: NodeJS.ProcessEnv = process.env): string {
  return env['ROUTINI_FLEET_EGRESS_IMAGE']?.trim() || 'ghcr.io/nvasion/routini-egress:latest'
}
