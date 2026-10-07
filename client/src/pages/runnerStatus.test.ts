import { describe, expect, it } from 'vitest'
import type { HostRunner } from '../lib/types'
import { agentsStatus, compareVersions, dockerFacts, updateOffer, type HostCommands } from './runnerStatus'

const commands: HostCommands = {
  reinstall: 'curl -fsSL https://raw.githubusercontent.com/nvasion/routini-runner/main/scripts/install.sh | sudo sh',
  enableAgents: 'sudo routini-runner-update --enable-agents',
}

const runner = (over: Partial<HostRunner> = {}): HostRunner => ({
  id: 'r1',
  name: 'web-01',
  version: '0.3.0',
  hostname: 'web-01',
  online: true,
  connectedAt: null,
  lastSeenAt: null,
  capabilities: ['exec', 'pty', 'update'],
  facts: { agents: { configured: false } },
  revoked: false,
  ...over,
})

describe('compareVersions', () => {
  it('orders release versions and ignores anything else', () => {
    expect(compareVersions('0.2.0', 'v0.3.0')).toBeLessThan(0)
    expect(compareVersions('v0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0', 'v0.3.0')).toBe(0)
    expect(compareVersions('0.1.0-test', 'v0.3.0')).toBeNull()
    expect(compareVersions(null, 'v0.3.0')).toBeNull()
  })
})

describe('updateOffer', () => {
  it('offers the button when the runner can update itself', () => {
    expect(updateOffer(runner({ version: '0.3.0' }), 'v0.3.1', commands)).toEqual({ kind: 'button', to: 'v0.3.1' })
  })
  it('offers the one-time reinstall for runners without the helper', () => {
    expect(updateOffer(runner({ version: '0.2.0', capabilities: ['exec', 'pty', 'agents'] }), 'v0.3.0', commands)).toEqual({
      kind: 'reinstall',
      to: 'v0.3.0',
      command: commands.reinstall,
    })
  })
  it('offers nothing when current, unknown or removed', () => {
    expect(updateOffer(runner({ version: '0.3.0' }), 'v0.3.0', commands)).toBeNull()
    expect(updateOffer(runner({ version: '0.4.0' }), 'v0.3.0', commands)).toBeNull()
    expect(updateOffer(runner(), null, commands)).toBeNull()
    expect(updateOffer(runner({ version: 'dev' }), 'v0.3.0', commands)).toBeNull()
    expect(updateOffer(runner({ version: '0.2.0', revoked: true }), 'v0.3.0', commands)).toBeNull()
  })
})

describe('agentsStatus', () => {
  it('is on with the Docker facts when the runner serves agents', () => {
    const r = runner({ capabilities: ['exec', 'agents'], facts: { docker: { available: true, version: '27.3.1', agentsRunning: 1, maxAgents: 2 }, agents: { configured: true } } })
    expect(agentsStatus(r, commands)).toEqual({ kind: 'on', docker: '27.3.1', running: 1, max: 2 })
    expect(dockerFacts(r)).toEqual({ version: '27.3.1', running: 1, max: 2 })
  })
  it('explains agents that are off, with the root command', () => {
    const s = agentsStatus(runner(), commands)
    expect(s).toMatchObject({ kind: 'off', command: 'sudo routini-runner-update --enable-agents' })
    expect(s.kind === 'off' && s.reason).toMatch(/root-equivalent/)
  })
  it('passes on why Docker did not answer', () => {
    const s = agentsStatus(runner({ facts: { agents: { configured: true, error: 'permission denied on /var/run/docker.sock' } } }), commands)
    expect(s.kind === 'off' && s.reason).toMatch(/Docker is not reachable: permission denied on \/var\/run\/docker\.sock/)
  })
  it('falls back to the installer for runners that do not report agents', () => {
    expect(agentsStatus(runner({ version: '0.1.1', capabilities: ['exec', 'pty'], facts: {} }), commands)).toEqual({
      kind: 'off',
      reason: 'This runner is too old to run agents (needs v0.2.0 or newer).',
      command: `${commands.reinstall} -s -- --enable-agents`,
    })
    expect(agentsStatus(runner({ version: '0.2.0', capabilities: ['exec'], facts: {} }), commands)).toMatchObject({ reason: 'Agents are not enabled on this host.' })
  })
  it('never reads a non-object docker fact as Docker', () => {
    expect(dockerFacts(runner({ facts: { docker: '27.1.1' } }))).toBeNull()
  })
})
