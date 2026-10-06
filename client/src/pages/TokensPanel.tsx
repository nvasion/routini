// Settings → API tokens: personal tokens for MCP clients (Claude Code, Claude
// Desktop, Cursor…) and scripts. Shown once; the MCP command is ready to paste.

import { useState, type FormEvent } from 'react'
import { Empty, ErrorBanner, Field } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { ApiToken, CreatedToken } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

export function TokensPanel() {
  const org = useOrg()
  const isAdmin = org.can('admin')
  const [all, setAll] = useState(false)
  const list = useApi<{ tokens: ApiToken[] }>(org.api(`/tokens${all ? '?all=1' : ''}`))
  const [name, setName] = useState('')
  const [role, setRole] = useState<'viewer' | 'member' | 'admin'>('member')
  const [expires, setExpires] = useState('90')
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { name: name.trim(), role }
      if (expires) body['expiresInDays'] = Number(expires)
      setCreated(await api<CreatedToken>(org.api('/tokens'), { body }))
      setName('')
      await list.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string, label: string) {
    if (!window.confirm(`Revoke "${label}"? Anything using it stops working.`)) return
    try {
      await api(org.api(`/tokens/${id}`), { method: 'DELETE' })
      await list.reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // clipboard unavailable; the text is selectable
    }
  }

  const roles = (['viewer', 'member', 'admin'] as const).filter((r) => org.can(r))

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="lead" style={{ margin: 0 }}>
        Use Routini from Claude Code, Claude Desktop or any MCP client: list runs and incidents, start jobs, run commands on your fleet. Commands follow your org&apos;s policy, and nothing
        can approve itself. Tokens also work as <span className="mono">Authorization: Bearer</span> for the REST API.
      </p>

      {created && (
        <div className="card" role="status">
          <div className="banner info">Copy this token now. It will not be shown again.</div>
          <pre className="code" aria-label="New token">
            {created.token}
          </pre>
          <span className="field-label">Add to Claude Code</span>
          <pre className="code" aria-label="MCP command" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {created.mcpCommand}
          </pre>
          <div className="inline">
            <button type="button" className="btn small" onClick={() => copy('token', created.token)}>
              {copied === 'token' ? 'Copied' : 'Copy token'}
            </button>
            <button type="button" className="btn small" onClick={() => copy('cmd', created.mcpCommand)}>
              {copied === 'cmd' ? 'Copied' : 'Copy command'}
            </button>
            <span className="meta">
              Other MCP clients: Streamable HTTP at <span className="mono">{created.mcpUrl}</span> with that header.
            </span>
          </div>
        </div>
      )}

      <form className="card" onSubmit={create}>
        <h3 style={{ margin: 0 }}>New token</h3>
        <div className="row">
          <Field label="Name" hint="Where it is used, e.g. laptop · Claude Code">
            {(id) => <input id={id} className="input" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Acts as" hint="Never more than your own role.">
            {(id) => (
              <select id={id} className="select" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r === 'viewer' ? 'Viewer (read only)' : r === 'member' ? 'Member (run jobs and commands)' : 'Admin'}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Expires">
            {(id) => (
              <select id={id} className="select" value={expires} onChange={(e) => setExpires(e.target.value)}>
                <option value="7">in 7 days</option>
                <option value="30">in 30 days</option>
                <option value="90">in 90 days</option>
                <option value="365">in a year</option>
                <option value="">never</option>
              </select>
            )}
          </Field>
        </div>
        <ErrorBanner error={error} />
        <div className="inline">
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </form>

      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{all ? 'All tokens in this org' : 'Your tokens'}</h3>
        {isAdmin && (
          <label className="inline" style={{ gap: 6 }}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show everyone&apos;s
          </label>
        )}
      </div>
      <div className="list">
        {list.data && list.data.tokens.length === 0 && <Empty>No tokens yet.</Empty>}
        {list.data?.tokens.map((tk) => (
          <div key={tk.id} className="list-row" style={{ cursor: 'default' }}>
            <span className="grow">
              <span className="title">{tk.name}</span>
              <span className="sub">
                {tk.role} · created {relativeTime(tk.createdAt)} · {tk.lastUsedAt ? `used ${relativeTime(tk.lastUsedAt)}` : 'never used'} ·{' '}
                {tk.expiresAt ? `expires ${relativeTime(tk.expiresAt)}` : 'no expiry'}
                {all && tk.userEmail ? ` · ${tk.userEmail}` : ''}
              </span>
            </span>
            <button type="button" className="btn small danger" onClick={() => revoke(tk.id, tk.name)}>
              Revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
