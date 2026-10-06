// Settings → Policy: ordered rules that gate steps, the egress allow-list,
// and whether the credential broker is on.

import { useEffect, useState } from 'react'
import { ErrorBanner, Field, Icon } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { OrgPolicy, PolicyEffect, PolicyMatch, PolicyRule } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

type ListKey = 'hostTags' | 'hostGroups' | 'repoHosts'

interface RuleForm extends Omit<PolicyRule, 'match'> {
  key: string
  match: Omit<PolicyMatch, ListKey>
  lists: Record<ListKey, string>
}

let counter = 0
const toForm = (r: PolicyRule): RuleForm => {
  const { hostTags, hostGroups, repoHosts, ...rest } = r.match
  return { ...r, key: `r${++counter}`, match: rest, lists: { hostTags: (hostTags ?? []).join(', '), hostGroups: (hostGroups ?? []).join(', '), repoHosts: (repoHosts ?? []).join(', ') } }
}

const splitList = (v: string) =>
  v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)

/** Form rules → API rules (empty match lists are dropped: "any"). */
export function rulesPayload(rules: RuleForm[]): PolicyRule[] {
  return rules.map(({ key: _key, lists, match, ...r }) => {
    const m: PolicyMatch = {}
    for (const [k, v] of Object.entries(match) as Array<[keyof PolicyMatch, unknown]>) {
      if (Array.isArray(v) ? v.length > 0 : v !== undefined) (m as Record<string, unknown>)[k] = v
    }
    for (const k of ['hostTags', 'hostGroups', 'repoHosts'] as const) {
      const items = splitList(lists[k])
      if (items.length) m[k] = items
    }
    const out: PolicyRule = { id: r.id, name: r.name, effect: r.effect, match: m }
    if (r.effect === 'require_approval') out.minRole = r.minRole ?? 'member'
    if (r.effect === 'deny' && r.reason?.trim()) out.reason = r.reason.trim()
    return out
  })
}

function newRuleId(existing: RuleForm[]): string {
  let n = existing.length + 1
  while (existing.some((r) => r.id === `rule-${n}`)) n++
  return `rule-${n}`
}

export function PolicyPanel() {
  const org = useOrg()
  const res = useApi<{ policy: OrgPolicy; brokerEnabled: boolean }>(org.api('/policy'))
  const [rules, setRules] = useState<RuleForm[]>([])
  const [hosts, setHosts] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const canEdit = org.can('admin')

  useEffect(() => {
    if (!res.data) return
    setRules(res.data.policy.rules.map(toForm))
    setHosts(res.data.policy.egress.allowedHosts.join('\n'))
  }, [res.data])

  const update = (key: string, patch: Partial<RuleForm>) => setRules((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const move = (i: number, by: -1 | 1) =>
    setRules((rs) => {
      const j = i + by
      if (j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })

  async function save() {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const body = { rules: rulesPayload(rules), egress: { allowedHosts: splitList(hosts.toLowerCase()) } }
      const out = await api<{ policy: OrgPolicy; brokerEnabled: boolean }>(org.api('/policy'), { method: 'PUT', body })
      res.setData(out)
      setNote('Policy saved. It applies to steps that start from now on.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (res.error) return <ErrorBanner error={res.error} />
  if (!res.data) return <p className="muted">Loading policy…</p>
  const { policy, brokerEnabled } = res.data

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className={`card broker-card${brokerEnabled ? ' on' : ''}`} role="status">
        <span className="inline" style={{ gap: 8 }}>
          <span className={`dot ${brokerEnabled ? 'ok' : 'off'}`} aria-hidden="true" />
          <strong>Credential broker {brokerEnabled ? 'on' : 'off'}</strong>
        </span>
        <span className="muted" style={{ fontSize: 13 }}>
          {brokerEnabled
            ? 'Agent and environment containers get placeholders instead of keys and reach the network only through the egress proxy. Credentials are added by the proxy, for the hosts they belong to.'
            : 'Agents receive model keys and integration tokens as environment variables and can reach any host. Turn the broker on in the server configuration (ROUTINI_EGRESS_*); hosted servers require it.'}
        </span>
      </div>

      <section className="stack" aria-labelledby="rules-title">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2 id="rules-title" className="section-title" style={{ margin: 0 }}>
            Rules
          </h2>
          <span className="meta">{policy.isDefault ? 'server defaults' : policy.updatedAt ? `saved ${relativeTime(policy.updatedAt)}` : ''}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Checked in order before each step runs; the first matching rule decides. Steps no rule matches are allowed. Blank conditions match anything.
        </p>
        {rules.length === 0 && <div className="empty">No rules: every step runs without extra approval.</div>}
        <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          {rules.map((r, i) => (
            <RuleCard key={r.key} rule={r} index={i} count={rules.length} onChange={(p) => update(r.key, p)} onMove={(by) => move(i, by)} onRemove={() => setRules((rs) => rs.filter((x) => x.key !== r.key))} />
          ))}
          {canEdit && (
            <div className="inline">
              <button
                type="button"
                className="btn"
                onClick={() => setRules((rs) => [...rs, toForm({ id: newRuleId(rs), name: 'New rule', match: { kinds: ['agent'] }, effect: 'require_approval', minRole: 'member' })])}
              >
                <Icon name="plus" size={14} /> Rule
              </button>
            </div>
          )}

          <section className="card" aria-labelledby="egress-title">
            <h3 id="egress-title">Egress allow-list</h3>
            <Field
              label="Hosts agents may reach"
              hint={
                brokerEnabled
                  ? 'One per line; *.example.com matches subdomains. The repository host and hosts with connected integrations are added per run. Anything else is refused and shown on the run.'
                  : 'Enforced only while the credential broker is on.'
              }
            >
              {(id) => <textarea id={id} className="textarea mono" rows={8} value={hosts} onChange={(e) => setHosts(e.target.value)} spellCheck={false} />}
            </Field>
          </section>

          {canEdit && (
            <div className="inline">
              <button type="button" className="btn primary" onClick={save}>
                {busy ? 'Saving…' : 'Save policy'}
              </button>
            </div>
          )}
        </fieldset>
        {note && <div className="banner info">{note}</div>}
        <ErrorBanner error={error} />
        {!canEdit && <span className="muted">Only admins can change the policy.</span>}
      </section>
    </div>
  )
}

const EFFECTS: Array<[PolicyEffect, string]> = [
  ['require_approval', 'Require approval'],
  ['deny', 'Block'],
  ['allow', 'Allow'],
]

function Checks<T extends string>({ label, options, value, onChange }: { label: string; options: Array<[T, string]>; value: T[] | undefined; onChange: (v: T[]) => void }) {
  const cur = value ?? []
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="inline" role="group" aria-label={label}>
        {options.map(([v, l]) => (
          <label key={v} className="inline" style={{ gap: 6 }}>
            <input type="checkbox" checked={cur.includes(v)} onChange={(e) => onChange(e.target.checked ? [...cur, v] : cur.filter((x) => x !== v))} />
            {l}
          </label>
        ))}
      </div>
    </div>
  )
}

function RuleCard(props: { rule: RuleForm; index: number; count: number; onChange: (p: Partial<RuleForm>) => void; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  const { rule: r, onChange: set, index } = props
  const m = r.match
  const setMatch = (patch: Partial<RuleForm['match']>) => set({ match: { ...m, ...patch } })
  const setList = (k: ListKey, v: string) => set({ lists: { ...r.lists, [k]: v } })
  const kinds = m.kinds ?? []
  const actions = kinds.length === 0 || kinds.includes('action')
  const agents = kinds.length === 0 || kinds.includes('agent')
  return (
    <div className="card">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <span className="meta">
          {index + 1} · {r.effect === 'deny' ? 'BLOCK' : r.effect === 'allow' ? 'ALLOW' : 'APPROVAL'}
        </span>
        <div className="inline">
          <button type="button" className="btn small" aria-label="Move rule up" disabled={index === 0} onClick={() => props.onMove(-1)}>
            ↑
          </button>
          <button type="button" className="btn small" aria-label="Move rule down" disabled={index === props.count - 1} onClick={() => props.onMove(1)}>
            ↓
          </button>
          <button type="button" className="btn small danger" aria-label={`Remove rule ${index + 1}`} onClick={props.onRemove}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
      <div className="row">
        <Field label="Rule name">{(id) => <input id={id} className="input" value={r.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />}</Field>
        <Field label="Then">
          {(id) => (
            <select id={id} className="select" value={r.effect} onChange={(e) => set({ effect: e.target.value as PolicyEffect })}>
              {EFFECTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </Field>
        {r.effect === 'require_approval' && (
          <Field label="Who can approve">
            {(id) => (
              <select id={id} className="select" value={r.minRole ?? 'member'} onChange={(e) => set({ minRole: e.target.value as RuleForm['minRole'] })}>
                <option value="member">Any member</option>
                <option value="admin">Admins</option>
                <option value="owner">Owners</option>
              </select>
            )}
          </Field>
        )}
      </div>
      {r.effect === 'deny' && (
        <Field label="Reason shown to the job author">{(id) => <input id={id} className="input" value={r.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} />}</Field>
      )}
      <Checks
        label="Step kinds"
        options={[
          ['action', 'Actions'],
          ['agent', 'Agents'],
        ]}
        value={m.kinds}
        onChange={(v) => setMatch({ kinds: v })}
      />
      {actions && (
        <>
          <Checks
            label="Action types"
            options={[
              ['http', 'HTTP'],
              ['ssh', 'Commands on hosts'],
              ['imap', 'IMAP'],
              ['factory', 'Factory'],
            ]}
            value={m.actionTypes}
            onChange={(v) => setMatch({ actionTypes: v })}
          />
          <div className="row">
            <Field label="Host tags" hint="Any of these, e.g. prod">
              {(id) => <input id={id} className="input mono" value={r.lists.hostTags} onChange={(e) => setList('hostTags', e.target.value)} />}
            </Field>
            <Field label="Host groups">{(id) => <input id={id} className="input mono" value={r.lists.hostGroups} onChange={(e) => setList('hostGroups', e.target.value)} />}</Field>
          </div>
        </>
      )}
      {agents && (
        <>
          <Checks
            label="Agent results"
            options={[
              ['pr', 'Pull request'],
              ['branch', 'Branch push'],
              ['none', 'Report only'],
            ]}
            value={m.agentOutputs}
            onChange={(v) => setMatch({ agentOutputs: v })}
          />
          <Checks
            label="Where agents run"
            options={[
              ['sandbox', 'Sandbox'],
              ['fleet', 'Fleet host'],
            ]}
            value={m.agentPlacements}
            onChange={(v) => setMatch({ agentPlacements: v })}
          />
          <div className="row">
            <Field label="Repository hosts" hint="e.g. github.com">
              {(id) => <input id={id} className="input mono" value={r.lists.repoHosts} onChange={(e) => setList('repoHosts', e.target.value)} />}
            </Field>
            <Field label="Where it runs">
              {(id) => (
                <select
                  id={id}
                  className="select"
                  value={m.inEnvironment === undefined ? 'any' : m.inEnvironment ? 'env' : 'fresh'}
                  onChange={(e) => setMatch({ inEnvironment: e.target.value === 'any' ? undefined : e.target.value === 'env' })}
                >
                  <option value="any">Anywhere</option>
                  <option value="env">In an environment</option>
                  <option value="fresh">In a fresh container</option>
                </select>
              )}
            </Field>
          </div>
        </>
      )}
    </div>
  )
}
