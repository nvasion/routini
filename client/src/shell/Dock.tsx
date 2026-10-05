// The right-side dock: Servers (host inventory + health), Envs (persistent
// workspaces), Terminal (a shell in an environment) and Live (follow a run's
// events as they happen). Collapsible to an icon rail; pops out into its own
// window at /o/:org/dock.

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Empty, ErrorBanner, Icon, Meter, StatusDot, type IconName } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi, useEventStream } from '../lib/hooks'
import type { Host, HostCheck, Inbox, RunEvent } from '../lib/types'
import { useOrg } from './OrgContext'
import { EnvsPanel, TerminalPanel } from './EnvPanels'

export const DOCK_TABS = ['servers', 'envs', 'terminal', 'live'] as const
export type DockTab = (typeof DOCK_TABS)[number]
const TAB_INFO: Record<DockTab, { label: string; icon: IconName; open: string }> = {
  servers: { label: 'Servers', icon: 'server', open: 'Open servers' },
  envs: { label: 'Envs', icon: 'box', open: 'Open environments' },
  terminal: { label: 'Terminal', icon: 'terminal', open: 'Open terminal' },
  live: { label: 'Live', icon: 'live', open: 'Open live run' },
}

interface DockState {
  open: boolean
  tab: DockTab
  runRef: string | null
  envId: string | null
  /** Opens a tab. `ref` is a run number for Live, an environment id for Terminal. */
  show(tab: DockTab, ref?: string): void
  close(): void
}

const DockCtx = createContext<DockState>({ open: false, tab: 'servers', runRef: null, envId: null, show: () => {}, close: () => {} })

const KEY = 'routini.dock'
function readDock(): { open: boolean; tab: DockTab } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { open?: boolean; tab?: DockTab } | null
    if (v?.tab && (DOCK_TABS as readonly string[]).includes(v.tab)) return { open: v.open !== false, tab: v.tab }
  } catch {
    // ignore
  }
  return { open: true, tab: 'servers' }
}

export function DockProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(readDock)
  const [runRef, setRunRef] = useState<string | null>(null)
  const [envId, setEnvId] = useState<string | null>(null)
  const persist = (s: { open: boolean; tab: DockTab }) => {
    setState(s)
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
      // ignore
    }
  }
  const value: DockState = {
    ...state,
    runRef,
    envId,
    show: (tab, ref) => {
      if (ref && tab === 'live') setRunRef(ref)
      if (ref && tab === 'terminal') setEnvId(ref)
      persist({ open: true, tab })
    },
    close: () => persist({ ...state, open: false }),
  }
  return <DockCtx.Provider value={value}>{children}</DockCtx.Provider>
}

export const useDock = () => useContext(DockCtx)

export function Dock({ standalone = false }: { standalone?: boolean }) {
  const dock = useDock()
  const org = useOrg()

  if (!dock.open && !standalone) {
    return (
      <aside className="dock closed" aria-label="Dock">
        <div className="dock-rail">
          {DOCK_TABS.map((id) => (
            <button key={id} type="button" className="btn icon" aria-label={TAB_INFO[id].open} onClick={() => dock.show(id)}>
              <Icon name={TAB_INFO[id].icon} />
            </button>
          ))}
        </div>
      </aside>
    )
  }

  return (
    <aside className="dock" aria-label="Dock" style={standalone ? { minHeight: '100vh', flex: 1 } : undefined}>
      <div className="dock-head">
        <div className="dock-tabs" role="tablist" aria-label="Dock panels">
          {DOCK_TABS.map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={dock.tab === id} onClick={() => dock.show(id)}>
              {TAB_INFO[id].label}
            </button>
          ))}
        </div>
        {!standalone && (
          <>
            <button
              type="button"
              className="btn icon"
              aria-label="Pop out dock into its own window"
              onClick={() => window.open(org.path(`/dock?tab=${dock.tab}`), 'routini-dock', 'width=520,height=860')}
            >
              <Icon name="external" size={16} />
            </button>
            <button type="button" className="btn icon" aria-label="Collapse dock" onClick={dock.close}>
              <Icon name="collapse" size={16} />
            </button>
          </>
        )}
      </div>
      <div className="dock-body">
        {dock.tab === 'servers' && <ServersPanel />}
        {dock.tab === 'envs' && <EnvsPanel />}
        {dock.tab === 'terminal' && <TerminalPanel />}
        {dock.tab === 'live' && <LivePanel />}
      </div>
    </aside>
  )
}

// ── Servers ──────────────────────────────────────────────────────────────────

function hostStatus(c: HostCheck | null): 'ok' | 'warn' | 'fail' | 'off' {
  if (!c) return 'off'
  if (!c.ok) return 'fail'
  if ((c.diskUsedPct ?? 0) >= 85 || (c.memUsedPct ?? 0) >= 90) return 'warn'
  return 'ok'
}

function hostNote(c: HostCheck | null): string {
  if (!c) return 'not checked'
  if (!c.ok) return 'unreachable'
  if ((c.diskUsedPct ?? 0) >= 85) return `disk ${c.diskUsedPct}%`
  if ((c.memUsedPct ?? 0) >= 90) return `mem ${c.memUsedPct}%`
  return 'healthy'
}

export function ServersPanel() {
  const org = useOrg()
  const { data, error, setData } = useApi<{ hosts: Host[] }>(org.api('/hosts'))
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  const hosts = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (data?.hosts ?? []).filter((h) => !f || [h.name, h.address, h.group, ...h.tags].some((x) => x.toLowerCase().includes(f)))
  }, [data, filter])
  const groups = useMemo(() => {
    const m = new Map<string, Host[]>()
    for (const h of hosts) m.set(h.group || 'ungrouped', [...(m.get(h.group || 'ungrouped') ?? []), h])
    return [...m.entries()]
  }, [hosts])
  const selected = hosts.find((h) => h.id === selectedId) ?? hosts[0] ?? null

  async function check(h: Host) {
    setChecking(true)
    setCheckError(null)
    try {
      const { check } = await api<{ check: HostCheck }>(org.api(`/hosts/${h.id}/check`), { method: 'POST' })
      setData((prev) => (prev ? { hosts: prev.hosts.map((x) => (x.id === h.id ? { ...x, lastCheck: check } : x)) } : prev))
    } catch (err) {
      setCheckError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  if (error) return <ErrorBanner error={error} />
  if (data && data.hosts.length === 0) {
    return (
      <Empty>
        No servers yet.{' '}
        {org.can('admin') ? <Link to={org.path('/settings/hosts')}>Add your first host</Link> : 'Ask an admin to add hosts.'}
      </Empty>
    )
  }
  return (
    <>
      <label className="searchbox">
        <Icon name="search" size={14} />
        <span className="sr-only">Filter servers</span>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter hosts, groups, tags" />
      </label>
      {groups.map(([group, list]) => (
        <div key={group} className="stack" style={{ gap: 2 }}>
          <div className="inline" style={{ justifyContent: 'space-between', padding: '4px 6px' }}>
            <span style={{ fontFamily: 'var(--font-sign)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: 13 }}>{group}</span>
            <span className="meta">{list.length}</span>
          </div>
          {list.map((h) => (
            <button
              key={h.id}
              type="button"
              className="nav-item"
              style={{ minHeight: 36, color: 'var(--ink)', background: selected?.id === h.id ? 'var(--hover)' : undefined }}
              aria-pressed={selected?.id === h.id}
              onClick={() => setSelectedId(h.id)}
            >
              <StatusDot status={hostStatus(h.lastCheck)} />
              <span className="mono" style={{ flex: 1, fontSize: 12 }}>
                {h.name}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                {hostNote(h.lastCheck)}
              </span>
            </button>
          ))}
        </div>
      ))}
      {selected && (
        <div className="card" style={{ padding: '12px 14px' }}>
          <div className="inline">
            <StatusDot status={hostStatus(selected.lastCheck)} />
            <span className="mono" style={{ flex: 1, fontWeight: 500 }}>
              {selected.name}
            </span>
            <span className="meta">{selected.lastCheck ? `checked ${relativeTime(selected.lastCheck.at)}` : 'never checked'}</span>
          </div>
          <div className="meta" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '4px 12px' }}>
            <span>
              {selected.username}@{selected.address}:{selected.port}
            </span>
            <span>{selected.lastCheck?.kernel ?? '—'}</span>
            <span>{selected.lastCheck?.uptime ?? '—'}</span>
            <span>{selected.tags.join(' · ') || 'no tags'}</span>
          </div>
          {selected.lastCheck?.ok && (
            <div className="stack" style={{ gap: 6 }}>
              {selected.lastCheck.diskUsedPct !== undefined && <Meter label="disk" pct={selected.lastCheck.diskUsedPct} />}
              {selected.lastCheck.memUsedPct !== undefined && <Meter label="mem" pct={selected.lastCheck.memUsedPct} />}
            </div>
          )}
          {selected.lastCheck && !selected.lastCheck.ok && <div className="meta" style={{ color: 'var(--fail)' }}>{selected.lastCheck.error}</div>}
          <ErrorBanner error={checkError} />
          <div className="inline">
            {org.can('member') && (
              <button type="button" className="btn small primary" disabled={checking} onClick={() => check(selected)}>
                {checking ? 'Checking…' : 'Check now'}
              </button>
            )}
            {org.can('admin') && (
              <Link className="btn small" to={org.path('/settings/hosts')}>
                Manage hosts
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ── Live ─────────────────────────────────────────────────────────────────────

export function LivePanel() {
  const org = useOrg()
  const dock = useDock()
  const inbox = useApi<Inbox>(org.api('/inbox'))
  const runRef = dock.runRef ?? (inbox.data?.live[0] ? String(inbox.data.live[0].number) : null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [ended, setEnded] = useState<string | null>(null)
  const [following, setFollowing] = useState<string | null>(null)

  if (runRef !== following) {
    setFollowing(runRef)
    setEvents([])
    setEnded(null)
  }

  useEventStream(
    runRef ? org.api(`/runs/${runRef}/stream`) : null,
    (type, data) => {
      if (type === 'end') setEnded((data as { status: string }).status)
      else setEvents((prev) => [...prev.slice(-300), data as RunEvent])
    },
    ['status', 'step.status', 'log', 'agent.message', 'agent.tool_call', 'agent.tool_result', 'agent.result', 'approval.requested', 'approval.decided', 'artifact', 'cost'],
  )

  if (!runRef) return <Empty>Nothing is running. Open a run and choose “Follow in dock”.</Empty>
  return (
    <>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <Link className="mono" to={org.path(`/runs/${runRef}`)}>
          run #{runRef}
        </Link>
        <span className="meta">{ended ? `ended · ${ended}` : 'live'}</span>
      </div>
      <div className="tl-entries" style={{ maxHeight: 'none', minHeight: 320, background: 'var(--term-bg)', color: 'var(--term-ink)' }} aria-live="polite">
        {events.length === 0 && <div className="tl-entry muted">Waiting for events…</div>}
        {events.map((e) => (
          <div key={e.id} className="tl-entry">
            <span className="muted">{new Date(e.ts).toLocaleTimeString()} </span>
            {liveLine(e)}
          </div>
        ))}
      </div>
    </>
  )
}

function liveLine(e: RunEvent): string {
  const d = e.data
  switch (e.type) {
    case 'log':
      return String(d['message'] ?? '')
    case 'status':
      return `run → ${String(d['status'])}`
    case 'step.status':
      return `step ${(e.stepIdx ?? 0) + 1} → ${String(d['status'])}`
    case 'agent.message':
      return `agent: ${String(d['text'] ?? '')}`
    case 'agent.tool_call':
      return `▸ ${String(d['name'])} ${String(d['input'] ?? '')}`
    case 'agent.tool_result':
      return `◂ ${String(d['name'] ?? 'tool')} ${d['ok'] === false ? 'error' : 'ok'}`
    case 'agent.init':
      return `agent started · ${String(d['model'] ?? 'default model')}`
    case 'agent.result':
      return `agent ${d['ok'] === false ? 'reported an error' : 'finished'}${d['summary'] ? `: ${String(d['summary'])}` : ''}`
    case 'approval.requested':
      return 'waiting for approval'
    case 'approval.decided':
      return `${String(d['decision'])} by ${String(d['by'])}`
    case 'artifact':
      return `artifact: ${String(d['url'] ?? d['branch'] ?? d['kind'])}`
    case 'cost':
      return `cost $${Number(d['usd'] ?? 0).toFixed(4)}`
    default:
      return e.type
  }
}
