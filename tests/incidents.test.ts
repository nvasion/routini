// The SRE loop: alert intake → incidents → runbooks (alert-triggered jobs with
// templating and alert-host targeting) → postmortems. Plus the pure pieces:
// alert normalization/matching and template escaping.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { makeTestApp, type TestApp, type TestUser } from './helpers/testApp'
import { Worker } from '../server/src/engine/worker'
import { alertMatches, fingerprintOf, glob, normalizeAlerts } from '../server/src/engine/alerts'
import { renderCommand, renderText, shellExports } from '../server/src/engine/template'
import type { StepExecutor } from '../server/src/engine/types'
import type { SshExecutor } from '../server/src/services/ssh'

const AM = (status: 'firing' | 'resolved', labels: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  version: '4',
  status,
  receiver: 'routini',
  groupLabels: {},
  commonLabels: {},
  alerts: [
    {
      status,
      labels: { alertname: 'DiskFull', severity: 'critical', instance: 'web-01:9100', ...labels },
      annotations: { summary: 'Disk above 90%', description: 'Root filesystem on web-01 is 93% full' },
      startsAt: '2026-10-05T10:00:00Z',
      endsAt: status === 'resolved' ? '2026-10-05T10:20:00Z' : '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus/graph',
      fingerprint: 'abc123',
      ...extra,
    },
  ],
})

describe('alert normalization and matching', () => {
  it('normalizes Alertmanager, Grafana and generic payloads', () => {
    const [a] = normalizeAlerts(AM('firing'))
    expect(a).toMatchObject({ fingerprint: 'abc123', name: 'DiskFull', status: 'firing', severity: 'critical', source: 'alertmanager', endsAt: null, startsAt: '2026-10-05T10:00:00.000Z' })
    expect(normalizeAlerts({ ...AM('resolved'), orgId: 1 })[0]).toMatchObject({ status: 'resolved', source: 'grafana', endsAt: '2026-10-05T10:20:00.000Z' })
    const [g] = normalizeAlerts({ title: 'API 5xx', status: 'ok', severity: 'WARNING', labels: { service: 'api' }, description: 'Too many errors' })
    expect(g).toMatchObject({ name: 'API 5xx', status: 'resolved', severity: 'warning', source: 'generic', annotations: { description: 'Too many errors' } })
    expect(g!.fingerprint).toBe(fingerprintOf('API 5xx', { service: 'api', alertname: 'API 5xx' }))
    expect(() => normalizeAlerts({ status: 'firing' })).toThrow(/needs a name/)
  })

  it('fingerprints ignore label order; matching uses names, severities and label globs', () => {
    expect(fingerprintOf('X', { a: '1', b: '2' })).toBe(fingerprintOf('X', { b: '2', a: '1' }))
    const [a] = normalizeAlerts(AM('firing'))
    expect(alertMatches({}, a!)).toBe(true)
    expect(alertMatches({ alertnames: ['Disk*'], severities: ['critical'], labels: { instance: 'web-*' } }, a!)).toBe(true)
    expect(alertMatches({ alertnames: ['CPUHigh'] }, a!)).toBe(false)
    expect(alertMatches({ labels: { team: 'db' } }, a!)).toBe(false)
    expect(glob('web*', 'web-01')).toBe(true)
    expect(glob('web', 'web-01')).toBe(false)
  })
})

describe('templating', () => {
  const data = { alert: { name: 'DiskFull', labels: { instance: "x'; rm -rf / #", path: '/var/log' } }, steps: { diag: { stdout: 'a b', exitCode: 0 } } }

  it('passes command values as environment variables, never as shell text', () => {
    const env: Record<string, string> = {}
    const cmd = renderCommand('du -sh {{alert.labels.path}} && echo {{alert.labels.instance}} {{nope.x}}', data, env)
    expect(cmd).toBe('du -sh "$ROUTINI_T1" && echo "$ROUTINI_T2" "$ROUTINI_T3"')
    expect(env).toEqual({ ROUTINI_T1: '/var/log', ROUTINI_T2: "x'; rm -rf / #", ROUTINI_T3: '' })
    // The hostile label comes out of a real shell as a single, inert argument.
    const out = execFileSync('sh', ['-c', shellExports(env) + 'printf "[%s]" ' + cmd.split('echo ')[1]!]).toString()
    expect(out).toBe("[x'; rm -rf / #][]")
  })

  it('percent-encodes in URLs and inserts as is elsewhere', () => {
    expect(renderText('https://x.example/q?h={{alert.labels.instance}}', data, 'url')).toBe(`https://x.example/q?h=${encodeURIComponent("x'; rm -rf / #")}`)
    expect(renderText('Disk on {{alert.labels.path}}: {{steps.diag.stdout}} (exit {{steps.diag.exitCode}})', data)).toBe('Disk on /var/log: a b (exit 0)')
    expect(renderText('{{constructor.name}} {{alert.__proto__}}', data)).toBe(' ')
  })
})

describe('the SRE loop', () => {
  let t: TestApp
  let u: TestUser
  let base: string
  let sshCommands: Array<{ host: string; command: string }>
  let prompts: string[]

  const sshExecutor: SshExecutor = {
    async exec(config, command) {
      sshCommands.push({ host: config.host, command })
      return { stdout: 'Filesystem 93%\n', stderr: '', exitCode: 0 }
    },
  }
  const agent: StepExecutor = {
    async execute(ctx) {
      prompts.push((ctx.step.config as { prompt: string }).prompt)
      await ctx.emit('agent.result', { ok: true, summary: 'Journald logs filled the disk; capped them at 500M.' })
      return { status: 'succeeded', output: {} }
    },
  }

  beforeEach(async () => {
    sshCommands = []
    prompts = []
    t = await makeTestApp({ engine: { actions: { sshExecutor }, executors: { agent } } })
    u = await t.signup('sre@example.com')
    base = `/api/orgs/${u.orgSlug}`
  })
  afterEach(async () => {
    await t.close()
  })

  async function setupToken(): Promise<string> {
    const r = await u.post(`${base}/alerts/token`)
    expect(r.status).toBe(201)
    expect(r.body.url).toMatch(new RegExp(`/api/alerts/${u.orgSlug}$`))
    return r.body.token
  }
  const send = (token: string, body: unknown) => t.request.post(`/api/alerts/${u.orgSlug}`).set('Authorization', `Bearer ${token}`).send(body as object)
  const drain = () => new Worker(t.ctx, t.ctx.engine, { heartbeatMs: 20 }).drain()

  async function webHost(): Promise<string> {
    await u.put(`${base}/credentials/ssh.web`, { value: 'not-a-real-key' })
    const h = await u.post(`${base}/hosts`, { name: 'web-01', address: '10.0.0.11', username: 'deploy', credentialKey: 'ssh.web', tags: ['prod'] })
    return h.body.host.id
  }

  it('authenticates intake with the org alert token', async () => {
    expect((await u.get(`${base}/alerts/settings`)).body.configured).toBe(false)
    expect((await t.request.post(`/api/alerts/${u.orgSlug}`).send(AM('firing'))).status).toBe(404)
    const token = await setupToken()
    expect((await u.get(`${base}/alerts/settings`)).body.configured).toBe(true)
    expect((await send('wrong', AM('firing'))).status).toBe(404)
    expect((await send(token, { nonsense: true })).status).toBe(400)
    expect((await send(token, AM('firing'))).status).toBe(202)
  })

  it('opens an incident, runs the matching runbook on the alert host, dedupes repeats, resolves, drafts a postmortem', async () => {
    const hostId = await webHost()
    const runbook = await u.post(`${base}/jobs`, {
      name: 'Disk full runbook',
      trigger: { kind: 'alert', match: { alertnames: ['DiskFull'], severities: ['critical'] } },
      steps: [
        { id: 'diag', name: 'Check disk', kind: 'action', config: { type: 'ssh', host: 'alert', command: 'df -h {{alert.labels.mount}} /' } },
        { id: 'fix', name: 'Agent: find the cause', kind: 'agent', config: { agent: 'claude', prompt: 'Disk check said: {{steps.diag.stdout}}' } },
      ],
    })
    expect(runbook.status).toBe(201)
    await u.post(`${base}/jobs`, { name: 'CPU runbook', trigger: { kind: 'alert', match: { alertnames: ['CPUHigh'] } }, steps: [{ name: 'noop', kind: 'action', config: { type: 'http', url: 'https://example.com' } }] })

    const token = await setupToken()
    const r1 = await send(token, AM('firing', { mount: "/var'x" }))
    expect(r1.body).toEqual({ received: 1, incidents: [{ incident: 1, status: 'open', opened: true, resolved: false, runs: [1] }] })
    const r2 = await send(token, AM('firing', { mount: "/var'x" }))
    expect(r2.body.incidents[0]).toMatchObject({ incident: 1, opened: false, runs: [] })

    await drain()
    const run = (await u.get(`${base}/runs/1`)).body
    expect(run.run.status).toBe('succeeded')
    expect(run.run.trigger).toMatchObject({ kind: 'alert', incidentNumber: 1, hostId })
    // Ran on the incident's host; the label travelled as a quoted export, not shell text.
    expect(sshCommands).toEqual([{ host: '10.0.0.11', command: `export ROUTINI_T1='/var'\\''x'; df -h "$ROUTINI_T1" /` }])
    expect(run.steps[0].output).toMatchObject({ hostId, exitCode: 0, stdout: 'Filesystem 93%\n' })
    // The agent got the alert context and the earlier step's output.
    expect(prompts[0]).toContain('## Alert context (incident #1)')
    expect(prompts[0]).toContain('Host: web-01 (10.0.0.11)')
    expect(prompts[0]).toContain('instance: web-01:9100')
    expect(prompts[0]!.endsWith('Disk check said: Filesystem 93%\n')).toBe(true)

    let inc = (await u.get(`${base}/incidents/1`)).body
    expect(inc.incident).toMatchObject({ status: 'open', severity: 'critical', alertCount: 2, hostId, hostName: 'web-01', title: 'DiskFull on web-01:9100: Disk above 90%' })
    expect(inc.runs).toMatchObject([{ number: 1, jobName: 'Disk full runbook', status: 'succeeded' }])
    expect(inc.events.map((e: { type: string }) => e.type)).toEqual(['alert.firing', 'run.started', 'alert.repeat', 'run.finished'])
    expect((await u.get(`${base}/inbox`)).body.incidents).toHaveLength(1)

    const r3 = await send(token, AM('resolved', { mount: "/var'x" }))
    expect(r3.body.incidents[0]).toMatchObject({ incident: 1, status: 'resolved', resolved: true })
    inc = (await u.get(`${base}/incidents/1`)).body
    const pm: string = inc.incident.postmortem.markdown
    expect(pm).toContain('# Postmortem: incident #1: DiskFull on web-01:9100')
    expect(pm).toContain('- **Host:** web-01')
    expect(pm).toContain('Routini started run #1 (Disk full runbook)')
    expect(pm).toContain('- **Check disk** (action): succeeded, exit 0')
    expect(pm).toContain('- Agent: Journald logs filled the disk; capped them at 500M.')
    expect(pm).toContain('alert resolved by the monitoring system')
    expect((await u.get(`${base}/inbox`)).body.incidents).toHaveLength(0)

    // A new firing alert after resolution opens a new incident.
    expect((await send(token, AM('firing', { mount: "/var'x" }))).body.incidents[0]).toMatchObject({ incident: 2, opened: true })
  })

  it('fails an alert-host step clearly when the alert names no known host', async () => {
    await u.post(`${base}/jobs`, { name: 'rb', trigger: { kind: 'alert', match: {} }, steps: [{ name: 'diag', kind: 'action', config: { type: 'ssh', host: 'alert', command: 'uptime' } }] })
    const token = await setupToken()
    await send(token, AM('firing', { instance: 'unknown-box:9100' }))
    await drain()
    expect((await u.get(`${base}/runs/1`)).body.steps[0].error).toBe("This step targets the alert's host, but the alert did not match a host in the fleet")
  })

  it('only allows the alert host in alert-triggered jobs', async () => {
    const r = await u.post(`${base}/jobs`, { name: 'x', steps: [{ name: 'diag', kind: 'action', config: { type: 'ssh', host: 'alert', command: 'uptime' } }] })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/needs an alert trigger/)
  })

  it('supports notes, manual resolve, regenerate, and keeps human edits to the postmortem', async () => {
    const token = await setupToken()
    await send(token, { title: 'Checkout latency', severity: 'warning', labels: { service: 'checkout' } }) // generic format
    expect((await u.post(`${base}/incidents/1/notes`, { text: 'Rolled back deploy 4812' })).status).toBe(201)
    const resolved = await u.post(`${base}/incidents/1/resolve`)
    expect(resolved.body.incident).toMatchObject({ status: 'resolved', resolvedBy: u.userId })
    expect(resolved.body.incident.postmortem.markdown).toContain('note by sre@example.com: Rolled back deploy 4812')
    expect(resolved.body.incident.postmortem.markdown).toContain('marked resolved by sre@example.com')

    const edited = await u.put(`${base}/incidents/1/postmortem`, { markdown: '# Our words' })
    expect(edited.body.incident.postmortem).toMatchObject({ markdown: '# Our words', editedBy: u.userId })
    // A later resolve-triggered draft never overwrites an edit; an explicit regenerate does.
    const regen = await u.post(`${base}/incidents/1/postmortem/generate`)
    expect(regen.body.incident.postmortem).toMatchObject({ editedAt: null })
    expect(regen.body.incident.postmortem.markdown).toContain('# Postmortem: incident #1')

    expect((await u.get(`${base}/incidents?status=resolved`)).body.incidents).toHaveLength(1)
    expect((await u.get(`${base}/incidents?status=open`)).body.incidents).toHaveLength(0)
    expect((await u.get(`${base}/incidents/99`)).status).toBe(404)
  })
})
