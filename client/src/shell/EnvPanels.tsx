// Dock panels for environments: a quick list (start / stop / terminal) and the
// terminal itself.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, ErrorBanner, StatusDot } from '../components/ui'
import { TerminalView } from '../components/TerminalView'
import { api } from '../lib/api'
import { useApi } from '../lib/hooks'
import type { Environment } from '../lib/types'
import { useDock } from './Dock'
import { useOrg } from './OrgContext'

export function envDot(s: Environment['status']): 'ok' | 'fail' | 'off' | 'live' {
  if (s === 'running') return 'ok'
  if (s === 'starting' || s === 'stopping' || s === 'deleting') return 'live'
  if (s === 'failed') return 'fail'
  return 'off'
}

/** Calls fn every `ms` while ms is not null. */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (ms === null) return
    const t = setInterval(() => ref.current(), ms)
    return () => clearInterval(t)
  }, [ms])
}

export function EnvsPanel() {
  const org = useOrg()
  const dock = useDock()
  const envs = useApi<{ environments: Environment[] }>(org.api('/environments'))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = envs.data?.environments ?? []
  const transitioning = list.some((e) => e.status === 'starting' || e.status === 'stopping')
  useInterval(() => void envs.reload(), transitioning ? 2000 : null)

  async function act(e: Environment, action: 'start' | 'stop') {
    setBusy(e.id)
    setError(null)
    try {
      await api(org.api(`/environments/${e.id}/${action}`), { method: 'POST' })
      await envs.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (envs.error) return <ErrorBanner error={envs.error} />
  return (
    <>
      <ErrorBanner error={error} />
      {envs.data && list.length === 0 && (
        <Empty>
          No environments yet. <Link to={org.path('/environments')}>Create one</Link>
        </Empty>
      )}
      {list.map((e) => (
        <div key={e.id} className="card" style={{ padding: '12px 14px', gap: 6 }}>
          <div className="inline">
            <StatusDot status={envDot(e.status)} />
            <span className="mono" style={{ flex: 1, fontWeight: 500 }}>
              {e.name}
            </span>
            <span className="meta">{e.status}</span>
          </div>
          <span className="meta">{e.repo ? `${e.repo.url.replace(/^https:\/\//, '')} @ ${e.repo.branch}` : 'no repository'}</span>
          {e.statusDetail && (
            <span className="meta" style={{ color: e.status === 'failed' ? 'var(--fail)' : undefined }}>
              {e.statusDetail}
            </span>
          )}
          {org.can('member') && (
            <div className="inline">
              {e.status === 'running' && (
                <button type="button" className="btn small primary" onClick={() => dock.show('terminal', e.id)}>
                  Terminal
                </button>
              )}
              {(e.status === 'stopped' || e.status === 'failed') && (
                <button type="button" className="btn small" disabled={busy === e.id} onClick={() => act(e, 'start')}>
                  Start
                </button>
              )}
              {e.status === 'running' && (
                <button type="button" className="btn small" disabled={busy === e.id} onClick={() => act(e, 'stop')}>
                  Stop
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <Link className="btn small" style={{ alignSelf: 'flex-start' }} to={org.path('/environments')}>
        Manage environments
      </Link>
    </>
  )
}

export function TerminalPanel() {
  const org = useOrg()
  const dock = useDock()
  const envs = useApi<{ environments: Environment[] }>(org.api('/environments'))
  const running = (envs.data?.environments ?? []).filter((e) => e.status === 'running')
  const selected = running.find((e) => e.id === dock.envId) ?? running[0] ?? null

  if (!org.can('member')) return <Empty>Viewers cannot open terminals.</Empty>
  if (envs.error) return <ErrorBanner error={envs.error} />
  if (envs.data && running.length === 0) {
    return (
      <Empty>
        No running environment. Start one in <Link to={org.path('/environments')}>Environments</Link>.
      </Empty>
    )
  }
  return (
    <>
      <label className="inline" style={{ gap: 8 }}>
        <span className="meta">environment</span>
        <select className="select" style={{ flex: 1 }} value={selected?.id ?? ''} onChange={(e) => dock.show('terminal', e.target.value)}>
          {running.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      {selected && <TerminalView key={selected.id} org={org.slug} envId={selected.id} height={420} />}
    </>
  )
}
