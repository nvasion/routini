// Environments: persistent workspaces (container + /workspace volume) that
// agents and people share.

import { useState, type FormEvent } from 'react'
import { Empty, ErrorBanner, Field, Modal, StatusDot } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { EnvEvent, Environment, Host } from '../lib/types'
import { useDock } from '../shell/Dock'
import { envDot, useInterval } from '../shell/EnvPanels'
import { useOrg } from '../shell/OrgContext'

export function EnvironmentsPage() {
  const org = useOrg()
  const dock = useDock()
  const envs = useApi<{ environments: Environment[] }>(org.api('/environments'))
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const list = envs.data?.environments ?? []
  useInterval(() => void envs.reload(), list.some((e) => e.status === 'starting' || e.status === 'stopping') ? 2000 : null)

  async function act(e: Environment, action: 'start' | 'stop' | 'delete') {
    if (action === 'delete' && !window.confirm(`Delete ${e.name}? Its /workspace volume is destroyed.`)) return
    setBusy(e.id)
    setError(null)
    try {
      if (action === 'delete') await api(org.api(`/environments/${e.id}`), { method: 'DELETE' })
      else await api(org.api(`/environments/${e.id}/${action}`), { method: 'POST' })
      await envs.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Environments</h1>
        {org.can('member') && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            New environment
          </button>
        )}
      </div>
      <p className="lead">
        A persistent workspace: a container with your repository in <span className="mono">/workspace</span>. Open a terminal in it, or point agent steps at it so they work
        where you can see the result. Stopping keeps <span className="mono">/workspace</span>; idle environments stop on their own.
      </p>
      <ErrorBanner error={envs.error ?? error} />
      <div className="list">
        {envs.data && list.length === 0 && <Empty>No environments yet.</Empty>}
        {list.map((e) => (
          <div key={e.id} className="list-row" style={{ flexWrap: 'wrap' }}>
            <StatusDot status={envDot(e.status)} label={e.status} />
            <button type="button" className="grow" style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit', padding: 0 }} onClick={() => setDetail(e.id)}>
              <span className="title mono">{e.name}</span>
              <span className="sub">
                {e.status}
                {e.statusDetail ? ` — ${e.statusDetail}` : ''} · {e.repo ? `${e.repo.url.replace(/^https:\/\//, '')} @ ${e.repo.branch}` : 'no repository'} · {e.cpus} CPU · {e.memoryMb / 1024} GB · active{' '}
                {relativeTime(e.lastActiveAt)}
                {e.host ? ` · on ${e.host.name}` : ''}
              </span>
            </button>
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
                {org.can('admin') && (
                  <button type="button" className="btn small danger" disabled={busy === e.id} onClick={() => act(e, 'delete')}>
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {creating && (
        <CreateEnvironment
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false)
            await envs.reload()
          }}
        />
      )}
      {detail && <EnvironmentDetail id={detail} onClose={() => setDetail(null)} />}
    </>
  )
}

/** Why a fleet host cannot host an environment, or null when it can (routini-runner ≥ 0.4.0, agents enabled). */
function hostBlocked(host: Host): string | null {
  const r = host.runner
  if (!r || r.revoked || !r.online) return 'offline'
  if (!r.capabilities.includes('environments')) return 'needs runner v0.4.0 with agents'
  return null
}

/** The "Host" select for a new environment: Routini (the default), then every runner host. */
function hostOptions(hosts: Host[]): Array<{ value: string; label: string; disabled: boolean }> {
  const options = [{ value: '', label: 'Routini', disabled: false }]
  for (const h of hosts) {
    if (h.transport !== 'runner') continue
    const blocked = hostBlocked(h)
    options.push({ value: h.id, label: blocked ? `${h.name} (${blocked})` : h.name, disabled: blocked !== null })
  }
  return options
}

function CreateEnvironment({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const org = useOrg()
  const hosts = useApi<{ hosts: Host[] }>(org.api('/hosts'))
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [image, setImage] = useState('')
  const [hostId, setHostId] = useState('')
  const [idle, setIdle] = useState('60')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(org.api('/environments'), {
        body: {
          name: name.trim(),
          ...(repoUrl.trim() ? { repo: { url: repoUrl.trim(), branch: branch.trim() || 'main' } } : {}),
          ...(image.trim() ? { image: image.trim() } : {}),
          ...(hostId ? { hostId } : {}),
          idleMinutes: Number(idle) || 60,
        },
      })
      await onCreated()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="New environment" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">{(id) => <input id={id} className="input mono" required value={name} placeholder="routini-dev" onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="row">
          <Field label="Repository (optional)" hint="Cloned into /workspace with your GitHub integration.">
            {(id) => <input id={id} className="input" value={repoUrl} placeholder="https://github.com/acme/app" onChange={(e) => setRepoUrl(e.target.value)} />}
          </Field>
          <Field label="Branch">{(id) => <input id={id} className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />}</Field>
        </div>
        <Field label="Host" hint="A fleet host runs the container behind its own egress proxy, instead of Routini's.">
          {(id) => (
            <select id={id} className="select" value={hostId} onChange={(e) => setHostId(e.target.value)}>
              {hostOptions(hosts.data?.hosts ?? []).map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="row">
          <Field label="Image" hint={hostId ? 'Blank defaults to the public Claude Code image.' : 'Blank uses the Claude Code agent image (git, node, python, claude).'}>
            {(id) => <input id={id} className="input mono" value={image} onChange={(e) => setImage(e.target.value)} />}
          </Field>
          <Field label="Stop when idle (minutes)">{(id) => <input id={id} className="input" inputMode="numeric" value={idle} onChange={(e) => setIdle(e.target.value)} />}</Field>
        </div>
        <ErrorBanner error={error} />
        <button type="submit" className="btn primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </form>
    </Modal>
  )
}

function EnvironmentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const org = useOrg()
  const d = useApi<{ environment: Environment; events: EnvEvent[] }>(org.api(`/environments/${id}`))
  const [copied, setCopied] = useState(false)
  const env = d.data?.environment
  return (
    <Modal title={env?.name ?? 'Environment'} onClose={onClose}>
      <ErrorBanner error={d.error} />
      {env && (
        <>
          <div className="meta" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '4px 12px' }}>
            <span>status: {env.status}</span>
            <span>image: {env.image}</span>
            <span>{env.repo ? `repo: ${env.repo.url} @ ${env.repo.branch}` : 'no repository'}</span>
            <span>stops after {env.idleMinutes} min idle</span>
          </div>
          {env.attachCommand && (
            <div className="stack" style={{ gap: 6 }}>
              <span className="muted">Attach from this machine (VS Code Dev Containers can attach to the same container):</span>
              <pre className="code">{env.attachCommand}</pre>
              <button
                type="button"
                className="btn small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void navigator.clipboard?.writeText(env.attachCommand!).then(() => setCopied(true))}
              >
                {copied ? 'Copied' : 'Copy command'}
              </button>
            </div>
          )}
          <h3 className="section-title">Activity</h3>
          <div className="list">
            {d.data!.events.length === 0 && <Empty>No activity yet.</Empty>}
            {d.data!.events.map((e) => (
              <div key={e.id} className="list-row" style={{ minHeight: 40 }}>
                <span className="grow">
                  <span className="title mono" style={{ fontSize: 12 }}>
                    {e.type}
                  </span>
                  <span className="sub">{Object.keys(e.data).length ? JSON.stringify(e.data) : ''}</span>
                </span>
                <span className="meta">{relativeTime(e.ts)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
