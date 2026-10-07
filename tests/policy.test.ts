// Org policy: rule matching, approve-then-run-once, deny, dry run, roles, defaults.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { evaluatePolicy, parseRules, PolicyError, stepFacts, type PolicyRule } from '../server/src/engine/policy'
import { hostAllowed, parseEgress } from '../server/src/repos/policy'
import type { AgentConfig, Step } from '../server/src/engine/spec'
import type { SshExecutor } from '../server/src/services/ssh'
import type { FetchFn } from '../server/src/services/http'

describe('rules', () => {
  const rules: PolicyRule[] = [
    { id: 'no-imap', name: 'No IMAP', match: { actionTypes: ['imap'] }, effect: 'deny', reason: 'not here' },
    { id: 'prod', name: 'Prod SSH', match: { actionTypes: ['ssh'], hostTags: ['prod'] }, effect: 'require_approval', minRole: 'admin' },
    { id: 'pr-only', name: 'Agents must open PRs', match: { kinds: ['agent'], agentOutputs: ['branch'] }, effect: 'deny' },
    { id: 'gh-agent', name: 'Agents on GitHub need approval', match: { kinds: ['agent'], repoHosts: ['github.com'], inEnvironment: false }, effect: 'require_approval' },
  ]

  it('first match wins; no match allows; approvals are never gated', () => {
    expect(evaluatePolicy(rules, { kind: 'action', actionType: 'imap' }).rule?.id).toBe('no-imap')
    expect(evaluatePolicy(rules, { kind: 'action', actionType: 'ssh', host: { tags: ['web', 'prod'], group: 'x' } }).effect).toBe('require_approval')
    expect(evaluatePolicy(rules, { kind: 'action', actionType: 'ssh', host: { tags: ['staging'], group: 'x' } }).effect).toBe('allow')
    expect(evaluatePolicy(rules, { kind: 'action', actionType: 'ssh' }).effect).toBe('allow') // unknown host: tag rule can't match
    expect(evaluatePolicy(rules, { kind: 'agent', agentOutput: 'branch', repoHost: 'github.com' }).rule?.id).toBe('pr-only')
    expect(evaluatePolicy(rules, { kind: 'agent', agentOutput: 'pr', repoHost: 'github.com', inEnvironment: false }).rule?.id).toBe('gh-agent')
    expect(evaluatePolicy(rules, { kind: 'agent', agentOutput: 'pr', repoHost: 'github.com', inEnvironment: true }).effect).toBe('allow')
    expect(evaluatePolicy([{ id: 'all', name: 'all', match: {}, effect: 'deny' }], { kind: 'approval' }).effect).toBe('allow')
  })

  it('blocks a teams step by actionType, and accepts azure-boards in the rule parser', () => {
    const denyTeams = parseRules([{ id: 'no-teams', name: 'No Teams', effect: 'deny', match: { actionTypes: ['teams'] } }])
    expect(evaluatePolicy(denyTeams, { kind: 'action', actionType: 'teams' }).effect).toBe('deny')
    expect(evaluatePolicy(denyTeams, { kind: 'action', actionType: 'azure-boards' }).effect).toBe('allow')
    expect(parseRules([{ id: 'boards', name: 'Boards', effect: 'allow', match: { actionTypes: ['azure-boards'] } }])[0]!.match.actionTypes).toEqual(['azure-boards'])
  })

  it('matches agent steps on where they run, with the fleet host tags', () => {
    const fleet: PolicyRule[] = [{ id: 'fleet-prod', name: 'Agents on prod fleet hosts', match: { kinds: ['agent'], agentPlacements: ['fleet'], hostTags: ['prod'] }, effect: 'require_approval' }]
    expect(evaluatePolicy(fleet, { kind: 'agent', agentPlacement: 'fleet', host: { tags: ['web', 'prod'], group: 'build' } }).rule?.id).toBe('fleet-prod')
    expect(evaluatePolicy(fleet, { kind: 'agent', agentPlacement: 'sandbox' }).effect).toBe('allow')
    expect(evaluatePolicy(fleet, { kind: 'agent', agentPlacement: 'fleet', host: { tags: ['staging'], group: 'build' } }).effect).toBe('allow')
    expect(evaluatePolicy(fleet, { kind: 'agent', agentPlacement: 'fleet' }).effect).toBe('allow') // host gone: the tag rule can't match
    const sandboxOnly: PolicyRule[] = [{ id: 'sandboxed', name: 'Sandbox agents', match: { agentPlacements: ['sandbox'] }, effect: 'deny' }]
    expect(evaluatePolicy(sandboxOnly, { kind: 'agent', agentPlacement: 'sandbox' }).rule?.id).toBe('sandboxed')
    expect(evaluatePolicy(sandboxOnly, { kind: 'agent', agentPlacement: 'fleet' }).effect).toBe('allow')
    expect(evaluatePolicy(sandboxOnly, { kind: 'action', actionType: 'http' }).effect).toBe('allow')
  })

  it('validates rule payloads with exact paths', () => {
    expect(() => parseRules([{ id: 'x', name: 'x', effect: 'nope', match: {} }])).toThrow(/rules\[0\]\.effect/)
    expect(() => parseRules([{ id: 'x', name: 'x', effect: 'allow', match: { actionTypes: ['ftp'] } }])).toThrow(/actionTypes values/)
    expect(() => parseRules([{ id: 'x', name: 'x', effect: 'allow', match: { agentPlacements: ['vm'] } }])).toThrow(/agentPlacements values must be among: sandbox, fleet/)
    expect(() => parseRules([{ id: 'x', name: 'x', effect: 'allow', match: { agentPlacements: 'fleet' } }])).toThrow(/agentPlacements must be a list of strings/)
    expect(parseRules([{ id: 'x', name: 'x', effect: 'allow', match: { agentPlacements: ['fleet', 'fleet'] } }])[0]!.match.agentPlacements).toEqual(['fleet'])
    expect(() => parseRules([{ id: 'a', name: 'a', effect: 'allow' }, { id: 'a', name: 'b', effect: 'allow' }])).toThrow(/used twice/)
    expect(() => parseRules([{ id: 'x', name: 'x', effect: 'require_approval', minRole: 'viewer' }])).toThrow(PolicyError)
    expect(parseRules([{ id: 'x', name: ' Deny all ', effect: 'deny', match: {} }])).toEqual([{ id: 'x', name: 'Deny all', match: {}, effect: 'deny', reason: 'Blocked by org policy' }])
  })

  it('egress allow-lists support exact hosts and *.suffix', () => {
    const allowed = parseEgress({ allowedHosts: ['API.github.com', '*.npmjs.org'] }).allowedHosts
    expect(allowed).toEqual(['api.github.com', '*.npmjs.org'])
    expect(hostAllowed(allowed, 'api.github.com')).toBe(true)
    expect(hostAllowed(allowed, 'registry.npmjs.org')).toBe(true)
    expect(hostAllowed(allowed, 'npmjs.org')).toBe(false)
    expect(hostAllowed(allowed, 'evil-npmjs.org')).toBe(false)
    expect(hostAllowed(allowed, 'github.com')).toBe(false)
    expect(() => parseEgress({ allowedHosts: ['http://x.com'] })).toThrow(/not a hostname/)
  })
})

describe('enforcement', () => {
  let t: TestApp
  let u: TestUser
  let worker: Worker
  const sshRan: string[] = []
  const ssh: SshExecutor = {
    async exec(_c, cmd) {
      sshRan.push(cmd)
      return { stdout: 'ok\n', stderr: '', exitCode: 0 }
    },
  }
  const okFetch: FetchFn = async () => new Response('ok', { status: 200 })
  const base = () => `/api/orgs/${u.orgSlug}`
  let hostId: string

  beforeEach(async () => {
    sshRan.length = 0
    t = await makeTestApp({ engine: { actions: { sshExecutor: ssh, http: { fetchImpl: okFetch, ssrfCheck: async () => true } } } })
    u = await t.signup('policy@example.com')
    worker = new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 })
    await u.put(`${base()}/credentials/ssh.key`, { value: 'not-a-real-key' })
    hostId = (await u.post(`${base()}/hosts`, { name: 'prod-web', address: '10.0.0.5', username: 'deploy', credentialKey: 'ssh.key', tags: ['prod'] })).body.host.id
  })
  afterEach(() => t.close())

  const sshJob = async () => {
    const job = await u.post(`${base()}/jobs`, {
      name: 'Restart',
      steps: [
        { name: 'probe', kind: 'action', config: { type: 'http', url: 'https://example.test' } },
        { name: 'restart api', kind: 'action', config: { type: 'ssh', hostId, command: 'systemctl restart api' } },
      ],
    })
    const run = await u.post(`${base()}/jobs/${job.body.job.id}/run`)
    return { jobId: job.body.job.id as string, number: run.body.run.number as number }
  }

  it('self-hosted orgs start with an empty policy', async () => {
    const res = await u.get(`${base()}/policy`)
    expect(res.body).toMatchObject({ policy: { rules: [], isDefault: true }, brokerEnabled: false })
    expect(res.body.policy.egress.allowedHosts).toContain('api.anthropic.com')
  })

  it('require_approval parks the run before the step, then runs it exactly once', async () => {
    await u.put(`${base()}/policy`, { rules: [{ id: 'prod', name: 'Prod changes', match: { actionTypes: ['ssh'], hostTags: ['prod'] }, effect: 'require_approval', minRole: 'admin' }] })
    const { number } = await sshJob()
    await worker.drain()
    let d = (await u.get(`${base()}/runs/${number}`)).body
    expect(d.run.status).toBe('waiting')
    expect(d.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'waiting'])
    expect(d.approvals[0]).toMatchObject({ source: 'policy', rule: 'Prod changes', minRole: 'admin', message: 'Policy "Prod changes" requires approval before "restart api" runs' })
    expect(sshRan).toEqual([])
    expect((await u.get(`${base()}/inbox`)).body.approvals).toHaveLength(1)

    const member = await t.signup('member-pol@example.com')
    await u.post(`${base()}/members`, { email: 'member-pol@example.com', role: 'member' })
    expect((await member.post(`${base()}/runs/${number}/steps/1/approve`)).status).toBe(403)
    expect((await u.post(`${base()}/runs/${number}/steps/1/approve`, { comment: 'ok' })).status).toBe(200)
    await worker.drain()
    d = (await u.get(`${base()}/runs/${number}`)).body
    expect(d.run.status).toBe('succeeded')
    expect(d.steps[1]).toMatchObject({ status: 'succeeded', policyCleared: true })
    expect(sshRan).toEqual(['systemctl restart api'])
  })

  it('denying a policy approval fails the step with the rule named', async () => {
    await u.put(`${base()}/policy`, { rules: [{ id: 'prod', name: 'Prod changes', match: { hostTags: ['prod'] }, effect: 'require_approval' }] })
    const { number } = await sshJob()
    await worker.drain()
    await u.post(`${base()}/runs/${number}/steps/1/deny`, { comment: 'not now' })
    await worker.drain()
    const d = (await u.get(`${base()}/runs/${number}`)).body
    expect(d.run.status).toBe('failed')
    expect(d.steps[1].error).toBe('Denied by policy@example.com under policy "Prod changes": not now')
    expect(sshRan).toEqual([])
  })

  it('deny fails the step immediately, and later steps follow `when` as usual', async () => {
    await u.put(`${base()}/policy`, { rules: [{ id: 'no-ssh', name: 'No SSH', match: { actionTypes: ['ssh'] }, effect: 'deny', reason: 'use the runner' }] })
    const { number } = await sshJob()
    await worker.drain()
    const d = (await u.get(`${base()}/runs/${number}`)).body
    expect(d.steps[1]).toMatchObject({ status: 'failed', error: 'Blocked by policy "No SSH": use the runner' })
    expect(d.run.status).toBe('failed')
  })

  it('applies to runs of jobs created before the rule existed', async () => {
    const job = await u.post(`${base()}/jobs`, { name: 'Old', steps: [{ name: 'restart', kind: 'action', config: { type: 'ssh', hostId, command: 'reboot' } }] })
    await u.put(`${base()}/policy`, { rules: [{ id: 'd', name: 'Deny', match: { actionTypes: ['ssh'] }, effect: 'deny' }] })
    await u.post(`${base()}/jobs/${job.body.job.id}/run`)
    await worker.drain()
    expect(sshRan).toEqual([])
  })

  it('dry-runs a job draft for the editor', async () => {
    await u.put(`${base()}/policy`, { rules: [{ id: 'prod', name: 'Prod changes', match: { hostTags: ['prod'] }, effect: 'require_approval', minRole: 'owner' }] })
    const res = await u.post(`${base()}/policy/evaluate`, {
      steps: [
        { id: 'a', kind: 'action', config: { type: 'http', url: 'https://x.test' } },
        { id: 'b', kind: 'action', config: { type: 'ssh', hostId, command: 'ls' } },
      ],
    })
    expect(res.body.decisions).toEqual([
      { stepId: 'a', effect: 'allow', rule: null },
      { stepId: 'b', effect: 'require_approval', rule: { id: 'prod', name: 'Prod changes', minRole: 'owner' } },
    ])
  })

  it('gates agent steps that run on a fleet host by that host’s tags', async () => {
    const enrollRunner = async (name: string, tags: string[]): Promise<string> => {
      const e = await u.post(`${base()}/runners/enrollments`, { name, group: 'build', tags })
      expect(e.status).toBe(201)
      const r = await t.request.post('/api/runner/enroll').send({ token: e.body.token, hostname: `${name}.example`, os: 'linux', arch: 'amd64', version: '0.1.0' })
      expect(r.status).toBe(201)
      return r.body.hostId as string
    }
    const prodHostId = await enrollRunner('agents-prod', ['prod'])
    const plainHostId = await enrollRunner('agents-lab', [])
    const rules: PolicyRule[] = [{ id: 'fleet-prod', name: 'Agents on prod hosts', match: { kinds: ['agent'], agentPlacements: ['fleet'], hostTags: ['prod'] }, effect: 'require_approval' }]
    const agentStep = (config: Partial<AgentConfig>): Step => ({ id: 'fix', name: 'Fix', kind: 'agent', when: 'on_success', retries: 0, config: { agent: 'claude', prompt: 'fix the flaky test', ...config } })
    const factsFor = (step: Step) => t.ctx.db.org(u.orgId, (q) => stepFacts(q, u.orgId, step))

    const onProd = await factsFor(agentStep({ runOn: { hostId: prodHostId } }))
    expect(onProd).toMatchObject({ kind: 'agent', agentPlacement: 'fleet', host: { tags: ['prod'], group: 'build' } })
    expect(evaluatePolicy(rules, onProd).rule?.id).toBe('fleet-prod')

    const inSandbox = await factsFor(agentStep({}))
    expect(inSandbox.agentPlacement).toBe('sandbox')
    expect(inSandbox.host).toBeUndefined()
    expect(evaluatePolicy(rules, inSandbox).effect).toBe('allow')

    const onPlain = await factsFor(agentStep({ runOn: { hostId: plainHostId } }))
    expect(onPlain).toMatchObject({ agentPlacement: 'fleet', host: { tags: [], group: 'build' } })
    expect(evaluatePolicy(rules, onPlain).effect).toBe('allow')

    // An alert-resolved step before prepare has no host yet, but still counts as fleet.
    const onAlertHost = await factsFor(agentStep({ runOn: { host: 'alert' } }))
    expect(onAlertHost).toMatchObject({ agentPlacement: 'fleet' })
    expect(onAlertHost.host).toBeUndefined()
  })

  it('only admins edit policy; bad payloads are rejected whole', async () => {
    const member = await t.signup('m2@example.com')
    await u.post(`${base()}/members`, { email: 'm2@example.com', role: 'member' })
    expect((await member.put(`${base()}/policy`, { rules: [] })).status).toBe(403)
    expect((await member.get(`${base()}/policy`)).status).toBe(200)
    const bad = await u.put(`${base()}/policy`, { rules: [{ id: 'x', name: 'x', effect: 'deny' }], egress: { allowedHosts: ['bad host'] } })
    expect(bad.status).toBe(400)
    expect((await u.get(`${base()}/policy`)).body.policy.isDefault).toBe(true)
  })

  it('hosted orgs get the production default', async () => {
    t.ctx.config.mode = 'hosted'
    const h = await t.signup('hosted-pol@example.com')
    const res = await h.get(`/api/orgs/${h.orgSlug}/policy`)
    expect(res.body.policy.rules).toEqual([expect.objectContaining({ id: 'prod-ssh', effect: 'require_approval', minRole: 'admin' })])
  })
})
