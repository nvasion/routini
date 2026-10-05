// ─────────────────────────────────────────────────────────────────────────────
// Postmortem drafts: a markdown document built from what actually happened
// (the incident's events and the runs it started). Deterministic, so it can be
// regenerated at any time; people edit it from there.
// ─────────────────────────────────────────────────────────────────────────────

import type { Queryable } from '../db/index.js'
import type { Incident, IncidentEvent, IncidentRun } from '../repos/incidents.js'
import { getIncident, listIncidentEvents, listIncidentRuns } from '../repos/incidents.js'
import { listApprovalsForRun, listEvents, listSteps, type Approval, type RunEvent, type RunStep } from '../repos/runs.js'

export interface PostmortemRun extends IncidentRun {
  steps: RunStep[]
  approvals: Array<Approval & { decidedByName: string | null }>
  agentSummaries: string[]
  artifacts: string[]
}

export interface PostmortemData {
  incident: Incident
  events: IncidentEvent[]
  runs: PostmortemRun[]
}

export async function loadPostmortemData(q: Queryable, orgId: string, incidentId: string): Promise<PostmortemData | null> {
  const incident = await getIncident(q, orgId, incidentId)
  if (!incident) return null
  const events = await listIncidentEvents(q, orgId, incidentId)
  const runs: PostmortemRun[] = []
  for (const r of await listIncidentRuns(q, orgId, incidentId)) {
    const steps = await listSteps(q, orgId, r.id)
    const approvals = await listApprovalsForRun(q, orgId, r.id)
    const names = new Map<string, string>()
    for (const a of approvals) {
      if (a.decidedBy && !names.has(a.decidedBy)) {
        const [u] = await q.query<{ name: string }>(`SELECT COALESCE(NULLIF(display_name, ''), email) AS name FROM users WHERE id = $1`, [a.decidedBy])
        if (u) names.set(a.decidedBy, u.name)
      }
    }
    const runEvents: RunEvent[] = await listEvents(q, orgId, r.id, 0, 2000)
    runs.push({
      ...r,
      steps,
      approvals: approvals.map((a) => ({ ...a, decidedByName: a.decidedBy ? names.get(a.decidedBy) ?? null : null })),
      agentSummaries: runEvents.filter((e) => e.type === 'agent.result' && typeof e.data['summary'] === 'string').map((e) => String(e.data['summary'])),
      artifacts: runEvents.filter((e) => e.type === 'artifact' && typeof e.data['url'] === 'string').map((e) => String(e.data['url'])),
    })
  }
  return { incident, events, runs }
}

const utc = (iso: string | null) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : '—')

function duration(from: string, to: string | null): string {
  if (!to) return 'ongoing'
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`
}

const oneLine = (s: string, max = 300) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export function buildPostmortem(d: PostmortemData): string {
  const i = d.incident
  const out: string[] = []
  out.push(`# Postmortem: incident #${i.number}: ${i.title}`, '')
  out.push('## Summary', '')
  out.push(`- **Alert:** ${i.labels['alertname'] ?? i.title} (${i.severity}), from ${i.source}`)
  out.push(`- **Host:** ${i.hostName ?? i.labels['instance'] ?? 'not identified'}`)
  out.push(`- **Opened:** ${utc(i.openedAt)} · **Resolved:** ${utc(i.resolvedAt)} · **Duration:** ${duration(i.openedAt, i.resolvedAt)}`)
  out.push(`- **Alerts received:** ${i.alertCount}`)
  if (i.annotations['summary']) out.push(`- **Summary from the alert:** ${oneLine(i.annotations['summary'])}`)
  if (i.annotations['description']) out.push(`- **Description:** ${oneLine(i.annotations['description'], 600)}`)
  out.push('', '## Impact', '', '_Who or what was affected, and how badly? (Fill in.)_', '')

  out.push('## Timeline (UTC)', '')
  for (const e of d.events) {
    const who = e.userName ? ` by ${e.userName}` : ''
    switch (e.type) {
      case 'alert.firing':
        out.push(`- ${utc(e.ts)}: alert **${String(e.data['name'] ?? i.title)}** fired (${String(e.data['severity'] ?? i.severity)})`)
        break
      case 'alert.repeat':
        break // counted in the summary
      case 'alert.resolved':
        out.push(`- ${utc(e.ts)}: alert resolved by the monitoring system`)
        break
      case 'run.started':
        out.push(`- ${utc(e.ts)}: Routini started run #${String(e.data['number'])} (${String(e.data['jobName'] ?? 'job')})`)
        break
      case 'run.finished':
        out.push(`- ${utc(e.ts)}: run #${String(e.data['number'])} ${String(e.data['status'])}`)
        break
      case 'note':
        out.push(`- ${utc(e.ts)}: note${who}: ${oneLine(String(e.data['text'] ?? ''), 600)}`)
        break
      case 'resolved':
        out.push(`- ${utc(e.ts)}: marked resolved${who}`)
        break
      default:
        out.push(`- ${utc(e.ts)}: ${e.type}${who}`)
    }
  }
  out.push('')

  out.push('## What Routini did', '')
  if (d.runs.length === 0) out.push('No runbook ran for this incident.', '')
  for (const r of d.runs) {
    out.push(`### Run #${r.number}: ${r.jobName} (${r.status}, ${duration(r.startedAt ?? r.createdAt, r.finishedAt)})`, '')
    for (const s of r.steps) {
      const out1 = s.output && typeof s.output === 'object' ? (s.output as Record<string, unknown>) : {}
      const exit = typeof out1['exitCode'] === 'number' ? `, exit ${String(out1['exitCode'])}` : ''
      out.push(`- **${s.name}** (${s.kind}): ${s.status}${exit}${s.error ? `: ${oneLine(s.error)}` : ''}`)
    }
    for (const a of r.approvals.filter((x) => x.status === 'approved' || x.status === 'denied')) {
      out.push(`- Decision: "${oneLine(a.message, 200)}" was **${a.status}**${a.decidedByName ? ` by ${a.decidedByName}` : ''}${a.decidedAt ? ` at ${utc(a.decidedAt)}` : ''}${a.comment ? `: "${oneLine(a.comment, 300)}"` : ''}`)
    }
    for (const sum of r.agentSummaries) out.push(`- Agent: ${oneLine(sum, 800)}`)
    for (const url of r.artifacts) out.push(`- Output: ${url}`)
    if (r.error && r.status === 'failed') out.push(`- Run error: ${oneLine(r.error)}`)
    out.push('')
  }

  out.push('## Root cause', '', '_What actually caused this? (Fill in.)_', '')
  out.push('## Follow-ups', '', '- [ ] _Prevent it from happening again_', '- [ ] _Detect it sooner_', '- [ ] _Automate the fix in the runbook_', '')
  return out.join('\n')
}
