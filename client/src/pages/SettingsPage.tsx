// Org settings: general & limits, members, models & keys, hosts, credentials, notifications.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { Empty, ErrorBanner, Field, Modal } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { AIEndpoint, AgentId, CredentialMeta, Host, Member, OrgSettings, Role } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

const TABS: Array<[string, string]> = [
  ['general', 'General'],
  ['members', 'Members'],
  ['models', 'Models'],
  ['hosts', 'Hosts'],
  ['credentials', 'Credentials'],
  ['notifications', 'Notifications'],
]

export function SettingsPage() {
  const org = useOrg()
  const { tab = 'general' } = useParams()
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        <span className="meta">your role: {org.org?.role}</span>
      </div>
      <nav className="tabs" aria-label="Settings sections">
        {TABS.map(([id, label]) => (
          <NavLink key={id} to={org.path(`/settings/${id}`)} className={() => `tab${tab === id ? ' active' : ''}`}>
            {label}
          </NavLink>
        ))}
      </nav>
      {tab === 'general' && <General />}
      {tab === 'members' && <Members />}
      {tab === 'models' && <Models />}
      {tab === 'hosts' && <Hosts />}
      {tab === 'credentials' && <Credentials />}
      {tab === 'notifications' && <Notifications />}
    </>
  )
}

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await fn()
      if (ok) setNote(ok)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const feedback: ReactNode = (
    <>
      {note && <div className="banner info">{note}</div>}
      <ErrorBanner error={error} />
    </>
  )
  return { busy, run, feedback }
}

// ── General ──────────────────────────────────────────────────────────────────

function General() {
  const org = useOrg()
  const o = org.org
  const [name, setName] = useState(o?.name ?? '')
  const [maxRuns, setMaxRuns] = useState(String(o?.limits.maxConcurrentRuns ?? ''))
  const [minutes, setMinutes] = useState(o?.limits.agentMinutesPerDay?.toString() ?? '')
  const [budget, setBudget] = useState(o?.limits.dailyBudgetUsd?.toString() ?? '')
  const { busy, run, feedback } = useAction()
  useEffect(() => {
    if (!o) return
    setName(o.name)
    setMaxRuns(String(o.limits.maxConcurrentRuns))
    setMinutes(o.limits.agentMinutesPerDay?.toString() ?? '')
    setBudget(o.limits.dailyBudgetUsd?.toString() ?? '')
  }, [o])
  if (!o) return null
  const num = (v: string) => (v.trim() === '' ? null : Number(v))

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          await api(org.api(), { method: 'PUT', body: { name, limits: { maxConcurrentRuns: Number(maxRuns), agentMinutesPerDay: num(minutes), dailyBudgetUsd: num(budget) } } })
          await org.reload()
        }, 'Saved.')
      }}
    >
      <fieldset disabled={!org.can('admin') || busy} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <Field label="Org name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <p className="muted" style={{ margin: 0 }}>
          Plan <span className="mono">{o.plan}</span>. Limits below can be tightened, not raised past the plan.
        </p>
        <div className="row">
          <Field label="Concurrent runs">{(id) => <input id={id} className="input" inputMode="numeric" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} />}</Field>
          <Field label="Agent minutes per day" hint="Blank = no limit (if the plan allows).">
            {(id) => <input id={id} className="input" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
          </Field>
          <Field label="Model budget per day (USD)" hint="Blank = no cap.">
            {(id) => <input id={id} className="input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />}
          </Field>
        </div>
        {org.can('admin') && (
          <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }}>
            Save
          </button>
        )}
      </fieldset>
      {feedback}
    </form>
  )
}

// ── Members ──────────────────────────────────────────────────────────────────

function Members() {
  const org = useOrg()
  const members = useApi<{ members: Member[] }>(org.api('/members'))
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const { busy, run, feedback } = useAction()
  const roles: Role[] = org.can('owner') ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer']

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="list">
        {members.data?.members.map((m) => (
          <div key={m.id} className="list-row">
            <span className="grow">
              <span className="title">{m.displayName || m.email}</span>
              <span className="sub">{m.email}</span>
            </span>
            {org.can('admin') ? (
              <>
                <label className="sr-only" htmlFor={`role-${m.id}`}>
                  Role for {m.email}
                </label>
                <select
                  id={`role-${m.id}`}
                  className="select"
                  style={{ width: 'auto' }}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) =>
                    run(async () => {
                      const res = await api<{ members: Member[] }>(org.api(`/members/${m.id}`), { method: 'PUT', body: { role: e.target.value } })
                      members.setData(res)
                    })
                  }
                >
                  {(['owner', 'admin', 'member', 'viewer'] as Role[]).map((r) => (
                    <option key={r} value={r} disabled={!roles.includes(r)}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={busy}
                  onClick={() =>
                    window.confirm(`Remove ${m.email} from this org?`) &&
                    run(async () => {
                      await api(org.api(`/members/${m.id}`), { method: 'DELETE' })
                      await members.reload()
                    })
                  }
                >
                  Remove
                </button>
              </>
            ) : (
              <span className="badge">{m.role}</span>
            )}
          </div>
        ))}
      </div>
      {org.can('admin') && (
        <form
          className="card"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            void run(async () => {
              const res = await api<{ members: Member[] }>(org.api('/members'), { body: { email, role } })
              members.setData(res)
              setEmail('')
            }, 'Added.')
          }}
        >
          <h3>Add a member</h3>
          <p className="muted" style={{ margin: 0 }}>
            They need a Routini account first. Email invitations come later.
          </p>
          <div className="row">
            <Field label="Email">{(id) => <input id={id} className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Role">
              {(id) => (
                <select id={id} className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {roles.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <button type="submit" className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Add
          </button>
        </form>
      )}
      {feedback}
    </div>
  )
}

// ── Models ───────────────────────────────────────────────────────────────────

const ENDPOINT_LABEL: Record<AIEndpoint, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  digitalocean: 'DigitalOcean',
  'aws-bedrock': 'AWS Bedrock',
  openai: 'OpenAI',
  google: 'Google',
  azure: 'Azure',
  gateway: 'Model gateway',
}
const AGENT_ENDPOINTS: Record<AgentId, AIEndpoint[]> = {
  claude: ['anthropic', 'openrouter', 'gateway'],
  opencode: ['anthropic', 'openai', 'openrouter'],
  omnimancer: ['anthropic', 'openrouter', 'digitalocean', 'aws-bedrock', 'openai', 'google', 'azure'],
}

function Models() {
  const org = useOrg()
  const settings = useApi<OrgSettings>(org.api('/settings'))
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [agents, setAgents] = useState<OrgSettings['ai']['agents'] | null>(null)
  const { busy, run, feedback } = useAction()
  useEffect(() => {
    if (settings.data) setAgents(settings.data.ai.agents)
  }, [settings.data])
  if (!settings.data || !agents) return <ErrorBanner error={settings.error} />
  const canEdit = org.can('admin')

  return (
    <form
      className="stack"
      style={{ gap: 16 }}
      onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          const endpointApiKeys = Object.fromEntries(Object.entries(keys).filter(([, v]) => v.trim()))
          const res = await api<OrgSettings>(org.api('/settings'), { method: 'PUT', body: { ai: { agents }, ...(Object.keys(endpointApiKeys).length ? { endpointApiKeys } : {}) } })
          settings.setData(res)
          setKeys({})
        }, 'Saved.')
      }}
    >
      <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <div className="card">
          <h3>Model keys</h3>
          <p className="muted" style={{ margin: 0 }}>
            Bring your own keys. They are encrypted and never shown again; enter a new value to replace one.
          </p>
          <div className="row">
            {(Object.keys(settings.data.endpointKeys) as AIEndpoint[]).map((ep) => (
              <Field key={ep} label={ENDPOINT_LABEL[ep]} hint={settings.data!.endpointKeys[ep] ? 'Key stored' : 'No key'}>
                {(id) => <input id={id} className="input" type="password" autoComplete="off" value={keys[ep] ?? ''} onChange={(e) => setKeys((k) => ({ ...k, [ep]: e.target.value }))} />}
              </Field>
            ))}
          </div>
        </div>
        {(Object.keys(agents) as AgentId[]).map((a) => (
          <div key={a} className="card">
            <h3>{a === 'claude' ? 'Claude Code' : a === 'omnimancer' ? 'Omnimancer' : 'OpenCode'}</h3>
            <div className="row">
              <Field label="Endpoint">
                {(id) => (
                  <select id={id} className="select" value={agents[a].endpoint} onChange={(e) => setAgents({ ...agents, [a]: { ...agents[a], endpoint: e.target.value as AIEndpoint } })}>
                    {AGENT_ENDPOINTS[a].map((ep) => (
                      <option key={ep} value={ep}>
                        {ENDPOINT_LABEL[ep]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Model" hint="Blank = the agent's default.">
                {(id) => <input id={id} className="input mono" value={agents[a].model} onChange={(e) => setAgents({ ...agents, [a]: { ...agents[a], model: e.target.value } })} />}
              </Field>
              {agents[a].endpoint === 'gateway' && (
                <Field label="Gateway URL">
                  {(id) => <input id={id} className="input" value={agents[a].gatewayUrl ?? ''} placeholder="http://gateway:8080" onChange={(e) => setAgents({ ...agents, [a]: { ...agents[a], gatewayUrl: e.target.value } })} />}
                </Field>
              )}
            </div>
          </div>
        ))}
        {canEdit && (
          <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }}>
            Save
          </button>
        )}
      </fieldset>
      {feedback}
    </form>
  )
}

// ── Hosts ────────────────────────────────────────────────────────────────────

interface HostDraft {
  id?: string
  name: string
  group: string
  address: string
  port: string
  username: string
  auth: 'key' | 'password'
  credentialKey: string
  tags: string
}
const blankHost: HostDraft = { name: '', group: '', address: '', port: '22', username: '', auth: 'key', credentialKey: '', tags: '' }

function Hosts() {
  const org = useOrg()
  const hosts = useApi<{ hosts: Host[] }>(org.api('/hosts'))
  const creds = useApi<{ credentials: CredentialMeta[] }>(org.api('/credentials'))
  const [draft, setDraft] = useState<HostDraft | null>(null)
  const { busy, run, feedback } = useAction()

  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    void run(async () => {
      const body = {
        name: draft.name.trim(),
        group: draft.group.trim(),
        address: draft.address.trim(),
        port: Number(draft.port),
        username: draft.username.trim(),
        auth: draft.auth,
        credentialKey: draft.credentialKey || null,
        tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
      }
      if (draft.id) await api(org.api(`/hosts/${draft.id}`), { method: 'PUT', body })
      else await api(org.api('/hosts'), { body })
      setDraft(null)
      await hosts.reload()
    }, 'Saved.')
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="lead">Servers jobs can reach over SSH. Store the private key or password under Credentials, then pick it here.</p>
      <div className="list">
        {hosts.data?.hosts.length === 0 && <Empty>No hosts yet.</Empty>}
        {hosts.data?.hosts.map((h) => (
          <div key={h.id} className="list-row">
            <span className="grow">
              <span className="title mono">{h.name}</span>
              <span className="sub">
                {h.username}@{h.address}:{h.port} · {h.group || 'ungrouped'} · {h.credentialKey ?? 'no credential'}
                {h.lastCheck ? ` · checked ${relativeTime(h.lastCheck.at)}` : ''}
              </span>
            </span>
            {org.can('admin') && (
              <>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setDraft({ id: h.id, name: h.name, group: h.group, address: h.address, port: String(h.port), username: h.username, auth: h.auth, credentialKey: h.credentialKey ?? '', tags: h.tags.join(', ') })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  disabled={busy}
                  onClick={() =>
                    window.confirm(`Delete host ${h.name}?`) &&
                    run(async () => {
                      await api(org.api(`/hosts/${h.id}`), { method: 'DELETE' })
                      await hosts.reload()
                    })
                  }
                >
                  Delete
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {org.can('admin') && (
        <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => setDraft({ ...blankHost })}>
          Add host
        </button>
      )}
      {feedback}
      {draft && (
        <Modal title={draft.id ? `Edit ${draft.name}` : 'Add host'} onClose={() => setDraft(null)}>
          <form className="stack" onSubmit={save}>
            <div className="row">
              <Field label="Name">{(id) => <input id={id} className="input mono" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
              <Field label="Group" hint="e.g. prod, staging">{(id) => <input id={id} className="input" value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} />}</Field>
            </div>
            <div className="row">
              <Field label="Address">{(id) => <input id={id} className="input mono" required value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />}</Field>
              <Field label="Port">{(id) => <input id={id} className="input" inputMode="numeric" value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />}</Field>
              <Field label="User">{(id) => <input id={id} className="input mono" required value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />}</Field>
            </div>
            <div className="row">
              <Field label="Auth">
                {(id) => (
                  <select id={id} className="select" value={draft.auth} onChange={(e) => setDraft({ ...draft, auth: e.target.value as HostDraft['auth'] })}>
                    <option value="key">Private key</option>
                    <option value="password">Password</option>
                  </select>
                )}
              </Field>
              <Field label="Credential" hint="A passphrase, if any, goes in “<key>.passphrase”.">
                {(id) => (
                  <select id={id} className="select" value={draft.credentialKey} onChange={(e) => setDraft({ ...draft, credentialKey: e.target.value })}>
                    <option value="">None</option>
                    {creds.data?.credentials.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.key}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <Field label="Tags" hint="Comma separated.">{(id) => <input id={id} className="input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />}</Field>
            <button type="submit" className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
              Save host
            </button>
            {feedback}
          </form>
        </Modal>
      )}
    </div>
  )
}

// ── Credentials ──────────────────────────────────────────────────────────────

function Credentials() {
  const org = useOrg()
  const creds = useApi<{ credentials: CredentialMeta[] }>(org.api('/credentials'))
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const { busy, run, feedback } = useAction()

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="lead">Secrets for hosts, mailboxes and other steps. Write-only: values are never shown again.</p>
      <div className="list">
        {creds.data?.credentials.length === 0 && <Empty>No credentials yet.</Empty>}
        {creds.data?.credentials.map((c) => (
          <div key={c.key} className="list-row">
            <span className="grow">
              <span className="title mono">{c.key}</span>
              <span className="sub">updated {relativeTime(c.updatedAt)}</span>
            </span>
            {org.can('admin') && (
              <button
                type="button"
                className="btn small danger"
                disabled={busy}
                onClick={() =>
                  window.confirm(`Delete credential ${c.key}?`) &&
                  run(async () => {
                    await api(org.api(`/credentials/${encodeURIComponent(c.key)}`), { method: 'DELETE' })
                    await creds.reload()
                  })
                }
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>
      {org.can('admin') && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api(org.api(`/credentials/${encodeURIComponent(key.trim())}`), { method: 'PUT', body: { value } })
              setKey('')
              setValue('')
              await creds.reload()
            }, 'Stored.')
          }}
        >
          <h3>Add or replace a credential</h3>
          <div className="row">
            <Field label="Key" hint="e.g. ssh.prod">{(id) => <input id={id} className="input mono" required value={key} onChange={(e) => setKey(e.target.value)} />}</Field>
          </div>
          <Field label="Value" hint="Paste a private key, password or token.">
            {(id) => <textarea id={id} className="textarea mono" rows={4} required autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <button type="submit" className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Store
          </button>
        </form>
      )}
      {feedback}
    </div>
  )
}

// ── Notifications ────────────────────────────────────────────────────────────

function Notifications() {
  const org = useOrg()
  const settings = useApi<OrgSettings>(org.api('/settings'))
  const [n, setN] = useState<OrgSettings['notifications'] | null>(null)
  const { busy, run, feedback } = useAction()
  useEffect(() => {
    if (settings.data) setN(settings.data.notifications)
  }, [settings.data])
  if (!n) return <ErrorBanner error={settings.error} />
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          const res = await api<OrgSettings>(org.api('/settings'), { method: 'PUT', body: { notifications: n } })
          settings.setData(res)
        }, 'Saved.')
      }}
    >
      <fieldset disabled={!org.can('admin') || busy} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <label className="inline">
          <input type="checkbox" checked={n.enabled} onChange={(e) => setN({ ...n, enabled: e.target.checked })} /> Email when runs finish
        </label>
        <Field label="Send to">{(id) => <input id={id} className="input" type="email" value={n.recipientEmail} onChange={(e) => setN({ ...n, recipientEmail: e.target.value })} />}</Field>
        <label className="inline">
          <input type="checkbox" checked={n.notifyOnFailure} onChange={(e) => setN({ ...n, notifyOnFailure: e.target.checked })} /> Failures
        </label>
        <label className="inline">
          <input type="checkbox" checked={n.notifyOnSuccess} onChange={(e) => setN({ ...n, notifyOnSuccess: e.target.checked })} /> Successes
        </label>
        <p className="muted" style={{ margin: 0 }}>
          Email delivery uses the server's SMTP settings.
        </p>
        {org.can('admin') && (
          <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }}>
            Save
          </button>
        )}
      </fieldset>
      {feedback}
    </form>
  )
}
