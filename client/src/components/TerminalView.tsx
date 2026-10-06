// An interactive terminal (xterm.js) connected to an environment's shell, or a
// fleet host's shell, over WebSocket. The session cookie authenticates the upgrade.

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { hostTerminalUrl, terminalUrl } from '../lib/terminalUrl'


function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function TerminalView({ org, envId, hostId, height = 380 }: { org: string; envId?: string; hostId?: string; height?: number }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: cssVar('--term-bg') || '#050505', foreground: cssVar('--term-ink') || '#d2cdc6', cursor: cssVar('--accent') || '#ffa53d' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    try {
      fit.fit()
    } catch {
      // not laid out yet
    }
    setState('connecting')
    const ws = new WebSocket(hostId ? hostTerminalUrl(org, hostId, term.cols, term.rows) : terminalUrl(org, envId!, term.cols, term.rows))
    ws.binaryType = 'arraybuffer'
    const send = (msg: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg))
    ws.onopen = () => {
      setState('open')
      term.focus()
    }
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
    ws.onclose = () => {
      setState('closed')
      term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
    }
    const onData = term.onData((data) => send({ type: 'input', data }))
    const onResize = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // ignore
      }
    })
    ro.observe(host.current)
    return () => {
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      ws.close()
      term.dispose()
    }
  }, [org, envId, hostId, attempt])

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div ref={host} style={{ height, background: 'var(--term-bg)', border: '1px solid var(--line-soft)', borderRadius: 6, padding: 6 }} aria-label="Terminal" />
      <div className="inline meta" style={{ justifyContent: 'space-between' }}>
        <span>{state === 'open' ? 'connected · session start and end are logged' : state === 'connecting' ? 'connecting…' : 'disconnected'}</span>
        {state === 'closed' && (
          <button type="button" className="btn small" onClick={() => setAttempt((a) => a + 1)}>
            Reconnect
          </button>
        )}
      </div>
    </div>
  )
}
