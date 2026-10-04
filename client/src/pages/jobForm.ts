// Job editor form model ⇄ API payload. Pure; see jobForm.test.ts.
// The server validates everything again; this catches the obvious early.

import type { AgentId, Job, Step, StepKind, When } from '../lib/types'

export interface StepForm {
  key: string
  id: string
  name: string
  kind: StepKind
  when: When
  retries: string
  timeoutSec: string
  // action
  actionType: 'http' | 'ssh' | 'imap'
  url: string
  method: string
  expectStatus: string
  headersJson: string
  body: string
  hostId: string
  command: string
  imapHost: string
  imapPort: string
  imapUser: string
  imapCredential: string
  mailbox: string
  search: string
  // agent
  agent: AgentId
  prompt: string
  repoUrl: string
  baseBranch: string
  output: 'pr' | 'branch' | 'none'
  checkCommand: string
  model: string
  // approval
  message: string
  minRole: 'member' | 'admin' | 'owner'
}

export interface JobForm {
  name: string
  description: string
  enabled: boolean
  triggerKind: 'manual' | 'cron' | 'webhook'
  cronExpr: string
  cronTz: string
  steps: StepForm[]
}

let counter = 0
const nextKey = () => `s${++counter}`

export function emptyStep(kind: StepKind, index: number): StepForm {
  return {
    key: nextKey(),
    id: `step-${index + 1}`,
    name: kind === 'approval' ? 'Approval' : kind === 'agent' ? 'Agent' : 'Action',
    kind,
    when: 'on_success',
    retries: '0',
    timeoutSec: '',
    actionType: 'http',
    url: '',
    method: 'GET',
    expectStatus: '',
    headersJson: '',
    body: '',
    hostId: '',
    command: '',
    imapHost: '',
    imapPort: '',
    imapUser: '',
    imapCredential: '',
    mailbox: '',
    search: '',
    agent: 'claude',
    prompt: '',
    repoUrl: '',
    baseBranch: 'main',
    output: 'pr',
    checkCommand: '',
    model: '',
    message: '',
    minRole: 'member',
  }
}

export function emptyJob(): JobForm {
  return { name: '', description: '', enabled: true, triggerKind: 'manual', cronExpr: '0 9 * * 1-5', cronTz: guessTz(), steps: [emptyStep('action', 0)] }
}

function guessTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function fromJob(job: Job): JobForm {
  return {
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    triggerKind: job.trigger.kind,
    cronExpr: job.trigger.kind === 'cron' ? job.trigger.expr : '0 9 * * 1-5',
    cronTz: job.trigger.kind === 'cron' ? job.trigger.tz : guessTz(),
    steps: job.steps.map((s, i) => fromStep(s, i)),
  }
}

function fromStep(s: Step, i: number): StepForm {
  const f = { ...emptyStep(s.kind, i), id: s.id, name: s.name, when: s.when, retries: String(s.retries ?? 0), timeoutSec: s.timeoutSec ? String(s.timeoutSec) : '' }
  if (s.kind === 'action') {
    const c = s.config
    f.actionType = c.type
    if (c.type === 'http') {
      Object.assign(f, { url: c.url, method: c.method ?? 'GET', expectStatus: c.expectStatus ? String(c.expectStatus) : '', headersJson: c.headers ? JSON.stringify(c.headers, null, 2) : '', body: c.body ?? '' })
    } else if (c.type === 'ssh') {
      Object.assign(f, { hostId: c.hostId, command: c.command })
    } else {
      Object.assign(f, { imapHost: c.host, imapPort: c.port ? String(c.port) : '', imapUser: c.username, imapCredential: c.credentialKey, mailbox: c.mailbox ?? '', search: c.search ?? '' })
    }
  } else if (s.kind === 'agent') {
    const c = s.config
    Object.assign(f, { agent: c.agent, prompt: c.prompt, repoUrl: c.repo?.url ?? '', baseBranch: c.repo?.baseBranch ?? 'main', output: c.output ?? (c.repo ? 'pr' : 'none'), checkCommand: c.check?.command ?? '', model: c.model ?? '' })
  } else {
    Object.assign(f, { message: s.config.message, minRole: s.config.minRole ?? 'member' })
  }
  return f
}

export type PayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; errors: string[] }

export function toPayload(form: JobForm): PayloadResult {
  const errors: string[] = []
  if (!form.name.trim()) errors.push('Give the job a name.')
  if (form.triggerKind === 'cron' && form.cronExpr.trim().split(/\s+/).length !== 5) errors.push('The schedule needs 5 cron fields: minute hour day month weekday.')
  if (form.steps.length === 0) errors.push('Add at least one step.')

  const steps = form.steps.map((s, i) => {
    const label = `Step ${i + 1} (${s.name || s.kind})`
    const base: Record<string, unknown> = { id: s.id.trim() || `step-${i + 1}`, name: s.name.trim() || `Step ${i + 1}`, kind: s.kind, when: s.when }
    const retries = Number(s.retries || 0)
    if (retries) base['retries'] = retries
    if (s.timeoutSec.trim()) {
      const t = Number(s.timeoutSec)
      if (!Number.isInteger(t) || t < 1) errors.push(`${label}: timeout must be a whole number of seconds.`)
      else base['timeoutSec'] = t
    }
    if (s.kind === 'action') {
      if (s.actionType === 'http') {
        if (!s.url.trim()) errors.push(`${label}: enter a URL.`)
        const cfg: Record<string, unknown> = { type: 'http', url: s.url.trim(), method: s.method }
        if (s.expectStatus.trim()) cfg['expectStatus'] = Number(s.expectStatus)
        if (s.headersJson.trim()) {
          try {
            cfg['headers'] = JSON.parse(s.headersJson)
          } catch {
            errors.push(`${label}: headers must be a JSON object.`)
          }
        }
        if (s.body) cfg['body'] = s.body
        base['config'] = cfg
      } else if (s.actionType === 'ssh') {
        if (!s.hostId) errors.push(`${label}: choose a host.`)
        if (!s.command.trim()) errors.push(`${label}: enter a command.`)
        base['config'] = { type: 'ssh', hostId: s.hostId, command: s.command }
      } else {
        if (!s.imapHost.trim() || !s.imapUser.trim() || !s.imapCredential.trim()) errors.push(`${label}: IMAP needs host, username and a credential.`)
        const cfg: Record<string, unknown> = { type: 'imap', host: s.imapHost.trim(), username: s.imapUser.trim(), credentialKey: s.imapCredential.trim() }
        if (s.imapPort.trim()) cfg['port'] = Number(s.imapPort)
        if (s.mailbox.trim()) cfg['mailbox'] = s.mailbox.trim()
        if (s.search.trim()) cfg['search'] = s.search.trim()
        base['config'] = cfg
      }
    } else if (s.kind === 'agent') {
      if (!s.prompt.trim()) errors.push(`${label}: tell the agent what to do.`)
      const cfg: Record<string, unknown> = { agent: s.agent, prompt: s.prompt }
      if (s.repoUrl.trim()) {
        cfg['repo'] = { url: s.repoUrl.trim(), baseBranch: s.baseBranch.trim() || 'main' }
        cfg['output'] = s.output
      }
      if (s.checkCommand.trim()) cfg['check'] = { command: s.checkCommand.trim() }
      if (s.model.trim()) cfg['model'] = s.model.trim()
      base['config'] = cfg
    } else {
      if (!s.message.trim()) errors.push(`${label}: say what is being approved.`)
      base['config'] = { message: s.message.trim(), minRole: s.minRole }
      delete base['retries']
    }
    return base
  })

  if (errors.length) return { ok: false, errors }
  const trigger = form.triggerKind === 'cron' ? { kind: 'cron', expr: form.cronExpr.trim(), tz: form.cronTz.trim() || 'UTC' } : { kind: form.triggerKind }
  return { ok: true, payload: { name: form.name.trim(), description: form.description, enabled: form.enabled, trigger, steps } }
}
