// What the Fleet page offers for a runner host: an update to the latest
// routini-runner release, and why agents can or cannot run there (with the
// exact command for whatever only root on the host may do). Pure; see
// runnerStatus.test.ts.

import type { HostRunner } from '../lib/types'

/** The host-side commands GET /runners/latest serves. */
export interface HostCommands {
  /** Upgrades an enrolled runner and installs the update helper. */
  reinstall: string
  /** Docker group (root-equivalent) + capabilities.agents, on runners ≥ 0.3.0. */
  enableAgents: string
}

export type UpdateOffer =
  /** The runner can update itself: POST /hosts/:id/runner/update. */
  | { kind: 'button'; to: string }
  /** No update helper yet (before 0.3.0): run the installer once on the host. */
  | { kind: 'reinstall'; to: string; command: string }

export type AgentsStatus =
  | { kind: 'on'; docker: string | null; running: number | null; max: number | null }
  | { kind: 'off'; reason: string; command: string | null }

/** "v0.3.0" or "0.3.0" → [0, 3, 0]; null for anything else (e.g. 0.1.0-test). */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Negative when a is older than b; null when either is not a release version. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!
  return 0
}

export function updateOffer(r: HostRunner, latest: string | null, commands: HostCommands | null): UpdateOffer | null {
  if (r.revoked || !latest) return null
  const cmp = compareVersions(r.version, latest)
  if (cmp === null || cmp >= 0) return null
  if (r.capabilities.includes('update')) return { kind: 'button', to: latest }
  return commands ? { kind: 'reinstall', to: latest, command: commands.reinstall } : null
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const num = (v: unknown) => (typeof v === 'number' ? v : null)
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

/** facts.docker (PROTOCOL.md 2.2): present only when the daemon answered. */
export function dockerFacts(r: HostRunner): { version: string | null; running: number | null; max: number | null } | null {
  const d = obj(r.facts?.['docker'])
  return d ? { version: str(d['version']), running: num(d['agentsRunning']), max: num(d['maxAgents']) } : null
}

export function agentsStatus(r: HostRunner, commands: HostCommands | null): AgentsStatus {
  if (r.capabilities.includes('agents')) {
    const d = dockerFacts(r)
    return { kind: 'on', docker: d?.version ?? null, running: d?.running ?? null, max: d?.max ?? null }
  }
  const a = obj(r.facts?.['agents'])
  if (!a) {
    // Before 0.3.0 the runner does not say why; the installer can do it all.
    const old = (compareVersions(r.version, '0.2.0') ?? -1) < 0
    return {
      kind: 'off',
      reason: old ? 'This runner is too old to run agents (needs v0.2.0 or newer).' : 'Agents are not enabled on this host.',
      command: commands ? `${commands.reinstall} -s -- --enable-agents` : null,
    }
  }
  if (a['configured'] === true) {
    return {
      kind: 'off',
      reason: `Agents are enabled, but Docker is not reachable${str(a['error']) ? `: ${str(a['error'])}` : ''}. Check that Docker 24+ is running and that the routini-runner user is in the docker group.`,
      command: commands?.enableAgents ?? null,
    }
  }
  return {
    kind: 'off',
    reason: 'Agents are off on this host. Turning them on gives the runner Docker access, which is root-equivalent, so only root on the host can do it.',
    command: commands?.enableAgents ?? null,
  }
}
