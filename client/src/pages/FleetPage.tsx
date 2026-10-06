// Fleet: every server Routini can reach, by runner (routini-runner dials out)
// or SSH. Add a server with a one-time install command, see live health from
// runner facts, open a terminal (admins), and read each host's audit trail.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Empty, ErrorBanner, Field, Icon, Meter, Modal, StatusDot } from '../components/ui'
import { TerminalView } from '../components/TerminalView'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { Enrollment, Host, HostEvent } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

export function hostState(h: Host): { status: 'ok' | 'warn' | 'fail' | 'off'; label: string } {
  if (h.transport === 'runner') {
    if (!h.runner || h.runner.revoked) return { status: 'off', label: 'runner removed' }
    if (!h.runner.online) return { status: 'fail', label: `offline${h.runner.lastSeenAt ? ` · seen ${relativeTime(h.runner.lastSeenAt)}` : ''}` }
  }
  const c = h.lastCheck
  if (!c) return { status: 'off', label: 'not checked' }
  if (!c.ok) return { status: 'fail', label: c.error ?? 'unreachable' }
  if ((c.diskUsedPct ?? 0) >= 85) return { status: 'warn', label: `disk ${c.diskUsedPct}%` }
  if ((c.memUsedPct ?? 0) >= 90) return { status: 'warn', label: `mem ${c.memUsedPct}%` }
  return { status: 'ok', label: h.transport === 'runner' ? 'online' : 'healthy' }
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined)

export function FleetPage() {
  const org = useOrg()
  const list = useApi<{ hosts: Host[] }>(org.api('/hosts'))
  const [adding, setAdding] = useState(false)
  const [terminal, setTerminal] = useState<Host | null>(null)
  const [details, setDetails] = useState<Host | null>(null)
  const [filter, setFilter] = useState('')

  // Runner status and facts change on their own; keep the page fresh.
  const reload = list.reload
  useEffect(() => {
    const t = window.setInterval(() => void reload(), 15_000)
    return () => window.clearInterval(t)
  }, [reload])

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const m = new Map<string, Host[]>()
    for (const h of list.data?.hosts ?? []) {
      if (f && ![h.name, h.address, h.group, ...h.tags].some((x) => x.toLowerCase().includes(f))) continue
      m.set(h.group || 'ungrouped', [...(m.get(h.group || 'ungrouped') ?? []), h])
    }
    return [...m.entries()]
  }, [list.data, filter])

  const hosts = list.data?.hosts ?? []
  const online = hosts.filter((h) => h.transport === 'runner' && h.runner?.online).length
  const runners = hosts.filter((h) => h.transport === 'runner').length

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Fleet</h1>
        <div className="inline">
          {list.data && (
            <span className="meta">
              {hosts.length} servers · {online}/{runners} runners online
            </span>
          )}
          {org.can('admin') && (
            <>
              <Link className="btn" to={org.path('/settings/hosts')}>
                Add SSH host
              </Link>
              <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} /> Add server
              </button>
            </>
          )}
        </div>
      </div>
      <p className="lead">
        Servers connect with <span className="mono">routini-runner</span>, a small open-source agent that only dials out: no inbound ports, no SSH keys stored here. Command steps, terminals and alert runbooks work the same on runner and SSH hosts.
      </p>
      <ErrorBanner error={list.error} />
      {list.data && hosts.length === 0 && (
        <Empty>
          No servers yet. {org.can('admin') ? 'Add one with the runner, or add an SSH host.' : 'Ask an admin to add servers.'}
        </Empty>
      )}
      {hosts.length > 0 && (
        <label className="searchbox" style={{ maxWidth: 420 }}>
          <Icon name="search" size={14} />
          <span className="sr-only">Filter servers</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, address, group or tag" />
        </label>
      )}
      {groups.map(([group, items]) => (
        <section key={group} className="section" aria-label={`Group ${group}`}>
          <h2 className="section-title">
            {group} <span className="meta">{items.length}</span>
          </h2>
          <div className="fleet-grid">
            {items.map((h) => (
              <HostCard key={h.id} host={h} onTerminal={() => setTerminal(h)} onDetails={() => setDetails(h)} onChecked={() => void list.reload()} />
            ))}
          </div>
        </section>
      ))}

      {adding && (
        <AddServerModal
          known={new Set(hosts.map((h) => h.id))}
          onClose={() => {
            setAdding(false)
            void list.reload()
          }}
        />
      )}
      {terminal && (
        <Modal wide title={`Terminal · ${terminal.name}`} onClose={() => setTerminal(null)}>
          <p className="meta" style={{ margin: 0 }}>
            {terminal.transport === 'runner' ? `as the runner's user on ${terminal.runner?.hostname ?? terminal.address}` : `${terminal.username}@${terminal.address} over SSH`} · this session is recorded in the host's audit trail
          </p>
          <TerminalView org={org.slug} hostId={terminal.id} height={420} />
        </Modal>
      )}
      {details && <HostDetails host={details} onClose={() => setDetails(null)} onRemoved={() => void list.reload()} />}
    </>
  )
}

function HostCard({ host: h, onTerminal, onDetails, onChecked }: { host: Host; onTerminal: () => void; onDetails: () => void; onChecked: () => void }) {
  const org = useOrg()
  const state = hostState(h)
  const facts = h.runner?.facts ?? {}
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canTerminal = org.can('admin') && (h.transport === 'ssh' ? !!h.credentialKey : !!h.runner?.online && h.runner.capabilities.includes('pty'))

  async function check() {
    setChecking(true)
    setError(null)
    try {
      await api(org.api(`/hosts/${h.id}/check`), { method: 'POST' })
      onChecked()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <article className="card host-card" aria-label={h.name}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <span className="inline" style={{ gap: 8, minWidth: 0 }}>
          <StatusDot status={state.status} label={state.label} />
          <span className="mono" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {h.name}
          </span>
        </span>
        <span className={`badge${h.transport === 'runner' ? ' accent' : ''}`}>{h.transport === 'runner' ? `runner ${h.runner?.version ?? ''}`.trim() : 'ssh'}</span>
      </div>
      <span className="meta">{state.label}</span>
      <div className="meta host-facts">
        <span>{h.transport === 'runner' ? h.runner?.hostname ?? h.address : `${h.username}@${h.address}:${h.port}`}</span>
        <span>{(facts['osPretty'] as string | undefined) ?? h.lastCheck?.kernel ?? '—'}</span>
        <span>{h.lastCheck?.uptime ?? '—'}</span>
        <span>
          {num(facts['load1']) !== undefined ? `load ${num(facts['load1'])!.toFixed(2)}` : '—'}
          {num(facts['cpus']) !== undefined ? ` · ${num(facts['cpus'])} cpu` : ''}
        </span>
      </div>
      {h.lastCheck?.ok && (state.status !== 'fail' || h.transport === 'ssh') && (
        <div className="stack" style={{ gap: 6 }}>
          {h.lastCheck.diskUsedPct !== undefined && <Meter label="disk" pct={h.lastCheck.diskUsedPct} />}
          {h.lastCheck.memUsedPct !== undefined && <Meter label="mem" pct={h.lastCheck.memUsedPct} />}
        </div>
      )}
      {h.tags.length > 0 && <span className="meta">{h.tags.map((t) => `#${t}`).join(' ')}</span>}
      <ErrorBanner error={error} />
      <div className="inline">
        {canTerminal && (
          <button type="button" className="btn small" onClick={onTerminal}>
            <Icon name="terminal" size={14} /> Terminal
          </button>
        )}
        {h.transport === 'ssh' && org.can('member') && (
          <button type="button" className="btn small" disabled={checking} onClick={check}>
            {checking ? 'Checking…' : 'Check'}
          </button>
        )}
        <button type="button" className="btn small" onClick={onDetails}>
          Details
        </button>
      </div>
    </article>
  )
}

const EVENT_LABEL: Record<string, string> = {
  'terminal.opened': 'Terminal opened',
  'terminal.closed': 'Terminal closed',
  'runner.connected': 'Runner connected',
  'runner.disconnected': 'Runner disconnected',
  'runner.removed': 'Runner removed',
}

function HostDetails({ host: h, onClose, onRemoved }: { host: Host; onClose: () => void; onRemoved: () => void }) {
  const org = useOrg()
  const events = useApi<{ events: HostEvent[] }>(org.api(`/hosts/${h.id}/events`))
  const [error, setError] = useState<string | null>(null)
  const facts = h.runner?.facts ?? {}

  async function remove() {
    if (!window.confirm(`Remove ${h.name}?${h.transport === 'runner' ? ' Its runner is revoked and stops.' : ''}`)) return
    try {
      await api(org.api(`/hosts/${h.id}`), { method: 'DELETE' })
      onRemoved()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal title={h.name} onClose={onClose}>
      <dl className="kv">
        <dt>Connection</dt>
        <dd>{h.transport === 'runner' ? `routini-runner ${h.runner?.version ?? ''}${h.runner?.online ? ' · online' : ' · offline'}` : `SSH ${h.username}@${h.address}:${h.port}`}</dd>
        {h.transport === 'runner' && (
          <>
            <dt>Hostname</dt>
            <dd className="mono">{h.runner?.hostname ?? '—'}</dd>
            <dt>Addresses</dt>
            <dd className="mono">{Array.isArray(facts['addresses']) ? (facts['addresses'] as string[]).join(', ') : h.address}</dd>
            <dt>Allows</dt>
            <dd>{h.runner?.capabilities.join(', ') || 'nothing'}</dd>
            <dt>Last seen</dt>
            <dd>{h.runner?.lastSeenAt ? relativeTime(h.runner.lastSeenAt) : 'never'}</dd>
          </>
        )}
        <dt>Group</dt>
        <dd>{h.group || '—'}</dd>
        <dt>Tags</dt>
        <dd>{h.tags.join(', ') || '—'}</dd>
      </dl>
      <h3 style={{ margin: '8px 0 0' }}>Audit trail</h3>
      <div className="list">
        {events.data && events.data.events.length === 0 && <Empty>No activity recorded yet.</Empty>}
        {events.data?.events.map((e) => (
          <div key={e.id} className="list-row" style={{ cursor: 'default' }}>
            <span className="grow">
              <span className="title">{EVENT_LABEL[e.type] ?? e.type}</span>
              <span className="sub">
                {relativeTime(e.ts)}
                {typeof e.data['seconds'] === 'number' ? ` · ${e.data['seconds']}s` : ''}
                {typeof e.data['via'] === 'string' ? ` · via ${e.data['via']}` : ''}
              </span>
            </span>
          </div>
        ))}
      </div>
      <ErrorBanner error={error ?? events.error} />
      {org.can('admin') && (
        <div className="inline">
          <button type="button" className="btn danger" onClick={remove}>
            Remove server
          </button>
        </div>
      )}
    </Modal>
  )
}

type InstallTab = 'script' | 'docker' | 'manual'
const INSTALL_TABS: Array<[InstallTab, string]> = [
  ['script', 'Linux (systemd)'],
  ['docker', 'Docker'],
  ['manual', 'Manual'],
]

function AddServerModal({ known, onClose }: { known: Set<string>; onClose: () => void }) {
  const org = useOrg()
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [tags, setTags] = useState('')
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [tab, setTab] = useState<InstallTab>('script')
  const [connected, setConnected] = useState<Host | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const knownRef = useRef(known)

  // Wait for the new runner to enroll and connect.
  useEffect(() => {
    if (!enrollment || connected) return
    const t = window.setInterval(() => {
      void api<{ hosts: Host[] }>(org.api('/hosts'))
        .then(({ hosts }) => {
          const fresh = hosts.find((h) => !knownRef.current.has(h.id) && h.transport === 'runner' && h.runner?.online)
          if (fresh) setConnected(fresh)
        })
        .catch(() => {})
    }, 2000)
    return () => window.clearInterval(t)
  }, [enrollment, connected, org])

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { group: group.trim(), tags: tags.split(/[\s,]+/).filter(Boolean) }
      if (name.trim()) body['name'] = name.trim()
      setEnrollment(await api<Enrollment>(org.api('/runners/enrollments'), { body }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable; the command is selectable
    }
  }

  return (
    <Modal title="Add a server" onClose={onClose}>
      {!enrollment ? (
        <form className="stack" onSubmit={create}>
          <p className="lead" style={{ margin: 0 }}>
            Routini gives you a one-time install command. Run it on the server; the runner enrolls, connects out over HTTPS and appears here.
          </p>
          <div className="row">
            <Field label="Name (optional)" hint="Defaults to the server's hostname.">
              {(id) => <input id={id} className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="web-01" />}
            </Field>
            <Field label="Group">{(id) => <input id={id} className="input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="prod" />}</Field>
          </div>
          <Field label="Tags" hint="Space or comma separated. Policy rules can match tags (e.g. prod).">
            {(id) => <input id={id} className="input mono" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="web prod" />}
          </Field>
          <ErrorBanner error={error} />
          <div className="inline">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Creating…' : 'Get install command'}
            </button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <div className="segmented" role="group" aria-label="Install method" style={{ alignSelf: 'flex-start' }}>
            {INSTALL_TABS.map(([id, label]) => (
              <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <pre className="code" aria-label="Install command" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {enrollment.commands[tab]}
          </pre>
          <div className="inline">
            <button type="button" className="btn small" onClick={() => copy(enrollment.commands[tab])}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="meta">The token works once and expires {relativeTime(enrollment.expiresAt)}.</span>
          </div>
          {connected ? (
            <div className="banner info" role="status">
              <StatusDot status="ok" /> <strong className="mono">{connected.name}</strong> is connected{connected.runner?.hostname ? ` (${connected.runner.hostname})` : ''}.
            </div>
          ) : (
            <div className="inline meta" role="status">
              <StatusDot status="live" /> Waiting for the runner to connect…
            </div>
          )}
          <div className="inline">
            <button type="button" className="btn primary" onClick={onClose}>
              {connected ? 'Done' : 'Close'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
