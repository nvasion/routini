// Integrations → MCP servers: remote (HTTP) MCP servers handed to agents as tools.
// Header values (API keys) are write-only; under the credential broker the
// agent's config holds placeholders and the egress proxy adds the real values.

import { useState, type FormEvent } from 'react'
import { Empty, ErrorBanner, Field, Icon, Modal } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useApi } from '../lib/hooks'
import type { AgentId, McpServer } from '../lib/types'
import { useOrg } from '../shell/OrgContext'

const AGENTS: Array<[AgentId, string]> = [
  ['claude', 'Claude Code'],
  ['omnimancer', 'Omnimancer'],
  ['opencode', 'OpenCode'],
]

export function McpServers() {
  const org = useOrg()
  const list = useApi<{ servers: McpServer[] }>(org.api('/mcp-servers'))
  const [open, setOpen] = useState<McpServer | 'new' | null>(null)
  const canEdit = org.can('admin')

  return (
    <section className="section" aria-labelledby="mcp-title">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h2 id="mcp-title" className="section-title" style={{ margin: 0 }}>
          MCP servers
        </h2>
        {canEdit && (
          <button type="button" className="btn" onClick={() => setOpen('new')}>
            <Icon name="plus" size={14} /> MCP server
          </button>
        )}
      </div>
      <p className="muted">Remote MCP servers give agents extra tools (issue trackers, docs, internal APIs). Agents connect over HTTP; headers are stored encrypted.</p>
      <ErrorBanner error={list.error} />
      {list.data && list.data.servers.length === 0 && <Empty>No MCP servers yet.</Empty>}
      <div className="list">
        {list.data?.servers.map((s) => (
          <button key={s.id} type="button" className="list-row" onClick={() => setOpen(s)}>
            <span className={`dot ${s.lastTest ? (s.lastTest.ok ? 'ok' : 'fail') : 'off'}`} aria-hidden="true" />
            <span className="grow">
              <span className="title mono">{s.name}</span>
              <span className="sub">{s.url}</span>
            </span>
            <span className="meta">agents: {s.agents.join(', ') || 'none'}</span>
          </button>
        ))}
      </div>
      {open && (
        <McpModal
          server={open === 'new' ? null : open}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
          onChange={(s, removed) => {
            list.setData((prev) => {
              const rest = (prev?.servers ?? []).filter((x) => x.id !== s.id)
              return { servers: removed ? rest : [...rest, s].sort((a, b) => a.name.localeCompare(b.name)) }
            })
            setOpen(removed ? null : s)
          }}
        />
      )}
    </section>
  )
}

function McpModal({ server, canEdit, onClose, onChange }: { server: McpServer | null; canEdit: boolean; onClose: () => void; onChange: (s: McpServer, removed?: boolean) => void }) {
  const org = useOrg()
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [agents, setAgents] = useState<AgentId[]>(server?.agents ?? ['claude'])
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>(server ? [] : [{ name: 'authorization', value: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await fn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const filled = headers.filter((h) => h.name.trim() && h.value)
      const body: Record<string, unknown> = { name: name.trim(), url: url.trim(), agents }
      if (filled.length || !server) body['headers'] = Object.fromEntries(filled.map((h) => [h.name.trim(), h.value]))
      const res = server
        ? await api<{ server: McpServer }>(org.api(`/mcp-servers/${server.id}`), { method: 'PUT', body })
        : await api<{ server: McpServer }>(org.api('/mcp-servers'), { body })
      setHeaders([])
      onChange(res.server)
      setNote('Saved.')
    })
  }

  return (
    <Modal title={server ? `MCP server ${server.name}` : 'Add MCP server'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <Field label="Name" hint="Lowercase; agents see the tools under this name.">
            {(id) => <input id={id} className="input mono" value={name} required pattern="[a-z0-9][a-z0-9_\-]{0,39}" onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="URL" hint="Streamable HTTP endpoint, e.g. https://mcp.linear.app/mcp">
            {(id) => <input id={id} className="input" type="url" value={url} required onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <div className="field">
            <span className="field-label">Headers</span>
            {server && server.headerNames.length > 0 && (
              <span className="hint">
                Stored: <span className="mono">{server.headerNames.join(', ')}</span>. Entering headers replaces all stored ones.
              </span>
            )}
            {headers.map((h, i) => (
              <div key={i} className="inline" style={{ flexWrap: 'nowrap' }}>
                <label className="sr-only" htmlFor={`mcp-h-${i}`}>
                  Header name
                </label>
                <input
                  id={`mcp-h-${i}`}
                  className="input mono"
                  style={{ maxWidth: 180 }}
                  placeholder="authorization"
                  value={h.name}
                  onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <label className="sr-only" htmlFor={`mcp-v-${i}`}>
                  Header value
                </label>
                <input
                  id={`mcp-v-${i}`}
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder="Bearer …"
                  value={h.value}
                  onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <button type="button" className="btn small" aria-label="Remove header" onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setHeaders((hs) => [...hs, { name: '', value: '' }])}>
              <Icon name="plus" size={14} /> Header
            </button>
          </div>
          <div className="field">
            <span className="field-label">Agents that may use it</span>
            <div className="inline">
              {AGENTS.map(([id, label]) => (
                <label key={id} className="inline" style={{ gap: 6 }}>
                  <input type="checkbox" checked={agents.includes(id)} onChange={(e) => setAgents((a) => (e.target.checked ? [...a, id] : a.filter((x) => x !== id)))} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          {canEdit && (
            <div className="inline">
              <button type="submit" className="btn primary">
                {server ? 'Save' : 'Add'}
              </button>
              {server && (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      run(async () => {
                        const { test } = await api<{ test: NonNullable<McpServer['lastTest']> }>(org.api(`/mcp-servers/${server.id}/test`), { method: 'POST' })
                        onChange({ ...server, lastTest: test })
                        setNote(test.ok ? `Test passed: ${test.message}` : `Test failed: ${test.message}`)
                      })
                    }
                  >
                    Test connection
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => {
                      if (!window.confirm(`Remove MCP server ${server.name}? Agents lose its tools.`)) return
                      void run(async () => {
                        await api(org.api(`/mcp-servers/${server.id}`), { method: 'DELETE' })
                        onChange(server, true)
                      })
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          )}
        </fieldset>
      </form>
      {server?.lastTest && (
        <span className="meta">
          last test {relativeTime(server.lastTest.at)}: {server.lastTest.ok ? 'passed' : 'failed'} — {server.lastTest.message}
        </span>
      )}
      {note && <div className="banner info">{note}</div>}
      <ErrorBanner error={error} />
      {!canEdit && <span className="muted">Only admins can change MCP servers.</span>}
    </Modal>
  )
}
