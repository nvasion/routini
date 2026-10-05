// The console frame: top bar, left nav, page, and the dock.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { Icon, type IconName } from '../components/ui'
import { Lockup } from '../components/Brand'
import { rememberOrg, useAuth } from '../lib/auth'
import { initials } from '../lib/format'
import { useApi, useEventStream } from '../lib/hooks'
import { THEMES, useTheme } from '../lib/theme'
import type { Host, Inbox, Job } from '../lib/types'
import { Dock, DOCK_TABS, DockProvider, useDock, type DockTab } from './Dock'
import { OrgProvider, useOrg } from './OrgContext'

export function OrgShell() {
  const { org: slug = '' } = useParams()
  useEffect(() => rememberOrg(slug), [slug])
  return (
    <OrgProvider key={slug} slug={slug}>
      <DockProvider>
        <div className="shell">
          <TopBar />
          <div className="body">
            <LeftNav />
            <main className="main" id="main">
              <Outlet />
            </main>
            <Dock />
          </div>
        </div>
      </DockProvider>
    </OrgProvider>
  )
}

/** /o/:org/dock — the dock alone, for the pop-out window. */
export function DockWindow() {
  const { org: slug = '' } = useParams()
  return (
    <OrgProvider slug={slug}>
      <DockProvider>
        <DockFromQuery />
      </DockProvider>
    </OrgProvider>
  )
}
function DockFromQuery() {
  const dock = useDock()
  const tab = new URLSearchParams(window.location.search).get('tab')
  useEffect(() => {
    if (tab && (DOCK_TABS as readonly string[]).includes(tab)) dock.show(tab as DockTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])
  return <Dock standalone />
}

function TopBar() {
  const { session, logout } = useAuth()
  const org = useOrg()
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const [menu, setMenu] = useState(false)

  return (
    <header className="rq-header">
      <Link className="brand" to={org.path('/inbox')} aria-label="Routini home">
        <Lockup size={34} sub="AI ENGINEER · ON TYNHUB" />
      </Link>

      <label className="inline" style={{ gap: 6 }}>
        <span className="sr-only">Org</span>
        <select className="select" style={{ width: 'auto', minHeight: 36 }} value={org.slug} onChange={(e) => navigate(`/o/${e.target.value}/inbox`)}>
          {session?.orgs.map((o) => (
            <option key={o.slug} value={o.slug}>
              {o.name}
            </option>
          ))}
        </select>
      </label>

      <CommandBar />

      <div className="segmented" role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {org.can('member') && (
        <Link className="btn primary" to={org.path('/jobs/new')}>
          New job
        </Link>
      )}

      <div style={{ position: 'relative' }}>
        <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={menu} aria-label="Account" onClick={() => setMenu((m) => !m)}>
          {initials(session?.user.displayName || session?.user.email || '?')}
        </button>
        {menu && (
          <div className="suggest" role="menu" style={{ left: 'auto', right: 0, width: 240 }}>
            <div className="list-row" style={{ cursor: 'default' }}>
              <span className="grow">
                <span className="title">{session?.user.displayName || 'Signed in'}</span>
                <span className="sub">{session?.user.email}</span>
              </span>
            </div>
            <LinkProvider />
            <button
              type="button"
              role="menuitem"
              className="list-row"
              onClick={async () => {
                await logout()
                navigate('/login')
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}

/** Quick jump: "#12" opens run 12; text matches jobs and hosts. */
function CommandBar() {
  const org = useOrg()
  const dock = useDock()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const jobs = useApi<{ jobs: Job[] }>(focused || q ? org.api('/jobs') : null)
  const hosts = useApi<{ hosts: Host[] }>(focused || q ? org.api('/hosts') : null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return []
    const out: Array<{ key: string; label: string; sub: string; go: () => void }> = []
    const runNum = /^#?(\d+)$/.exec(term)
    if (runNum) out.push({ key: `run-${runNum[1]}`, label: `Run #${runNum[1]}`, sub: 'open run', go: () => navigate(org.path(`/runs/${runNum[1]}`)) })
    for (const j of jobs.data?.jobs ?? []) {
      if (j.name.toLowerCase().includes(term)) out.push({ key: j.id, label: j.name, sub: 'job', go: () => navigate(org.path(`/jobs/${j.id}`)) })
    }
    for (const h of hosts.data?.hosts ?? []) {
      if (h.name.toLowerCase().includes(term) || h.address.includes(term)) out.push({ key: h.id, label: h.name, sub: `host · ${h.address}`, go: () => dock.show('servers') })
    }
    return out.slice(0, 8)
  }, [q, jobs.data, hosts.data, navigate, org, dock])

  const pick = (i: number) => {
    results[i]?.go()
    setQ('')
    input.current?.blur()
  }

  return (
    <div className="searchbox" style={{ flex: '1 1 300px' }}>
      <Icon name="search" size={16} />
      <label className="sr-only" htmlFor="cmd">
        Jump to a run, job or host
      </label>
      <input
        id="cmd"
        ref={input}
        value={q}
        placeholder="Jump to #run, job or host"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') pick(0)
          if (e.key === 'Escape') setQ('')
        }}
      />
      <span className="kbd">Ctrl K</span>
      {focused && results.length > 0 && (
        <div className="suggest" role="listbox">
          {results.map((r, i) => (
            <button key={r.key} type="button" role="option" aria-selected={i === 0} className="list-row" onMouseDown={() => pick(i)}>
              <span className="grow">
                <span className="title">{r.label}</span>
                <span className="sub">{r.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LeftNav() {
  const org = useOrg()
  const dock = useDock()
  const inbox = useApi<Inbox>(org.api('/inbox'))
  // Refresh the badge whenever any run in the org changes.
  useEventStream(org.api('/stream'), () => void inbox.reload(), ['run'])
  const needs = (inbox.data?.approvals.length ?? 0) + (inbox.data?.failures.length ?? 0)
  const running = (inbox.data?.live ?? []).filter((r) => r.status === 'running').length
  const openIncidents = inbox.data?.incidents?.length ?? 0

  const item = (to: string, icon: IconName, label: string, extra?: ReactNode) => (
    <NavLink to={org.path(to)} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
      <Icon name={icon} />
      <span>{label}</span>
      {extra}
    </NavLink>
  )
  const limits = org.org?.limits
  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav-label">Work</div>
      {item('/inbox', 'inbox', 'Inbox', needs > 0 ? <span className="count" aria-label={`${needs} need attention`}>{needs}</span> : null)}
      {item('/runs', 'runs', 'Runs', running > 0 ? <span className="dot running pulse" style={{ marginLeft: 'auto' }} aria-label={`${running} running`} /> : null)}
      {item('/incidents', 'alert', 'Incidents', openIncidents > 0 ? <span className="count" aria-label={`${openIncidents} open incidents`}>{openIncidents}</span> : null)}
      {item('/jobs', 'jobs', 'Jobs')}
      {item('/fleet', 'server', 'Fleet')}
      {item('/environments', 'box', 'Environments')}
      {item('/integrations', 'plug', 'Integrations')}
      {item('/settings', 'settings', 'Settings')}
      <div className="nav-label" style={{ paddingTop: 18 }}>
        Dock
      </div>
      <button type="button" className="nav-item" onClick={() => dock.show('servers')}>
        <Icon name="server" />
        <span>Servers</span>
      </button>
      <button type="button" className="nav-item" onClick={() => dock.show('terminal')}>
        <Icon name="terminal" />
        <span>Terminal</span>
      </button>
      <button type="button" className="nav-item" onClick={() => dock.show('live')}>
        <Icon name="live" />
        <span>Live run</span>
      </button>
      {limits && (
        <div className="nav-foot">
          <span>
            {org.org?.plan} plan · {limits.maxConcurrentRuns} concurrent
          </span>
          <span>{limits.agentMinutesPerDay === null ? 'agent minutes: unlimited' : `agent minutes: ${limits.agentMinutesPerDay}/day`}</span>
          <span>{limits.dailyBudgetUsd === null ? 'model budget: your keys, no cap' : `model budget: $${limits.dailyBudgetUsd}/day`}</span>
        </div>
      )}
    </nav>
  )
}

/** Account menu: link a password account to the identity provider (TynHub), once. */
function LinkProvider() {
  const ids = useApi<{ provider: { name: string; linked: boolean } | null }>('/api/auth/identities')
  const p = ids.data?.provider
  if (!p) return null
  if (p.linked) {
    return (
      <div className="list-row meta" style={{ cursor: 'default' }}>
        Linked to {p.name}
      </div>
    )
  }
  return (
    <a role="menuitem" className="list-row" href={`/api/auth/oidc/start?link=1`}>
      Link your {p.name} account
    </a>
  )
}
