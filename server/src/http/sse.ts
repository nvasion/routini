// ─────────────────────────────────────────────────────────────────────────────
// Server-sent events helper. Each event carries an `id` so a reconnecting
// browser resumes from Last-Event-ID; a comment heartbeat keeps proxies from
// closing idle streams.
// ─────────────────────────────────────────────────────────────────────────────

import type { Request, Response } from 'express'

export interface SseStream {
  send(event: string, data: unknown, id?: number): void
  close(): void
  readonly closed: boolean
}

export function openSse(req: Request, res: Response, heartbeatMs = 15_000): SseStream {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // nginx: do not buffer
  res.flushHeaders()
  res.write(': connected\n\n')

  let closed = false
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, heartbeatMs)
  const stream: SseStream = {
    get closed() {
      return closed
    },
    send(event, data, id) {
      if (closed) return
      if (id !== undefined) res.write(`id: ${id}\n`)
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      res.end()
    },
  }
  req.on('close', () => {
    closed = true
    clearInterval(heartbeat)
  })
  return stream
}

/** The event id to resume after: Last-Event-ID header, else ?after=, else 0. */
export function resumeFrom(req: Request): number {
  const raw = req.header('last-event-id') ?? (typeof req.query['after'] === 'string' ? req.query['after'] : '0')
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 0
}
