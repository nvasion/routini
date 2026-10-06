// Test harness: a routed fetch mock, a fake EventSource, and a render helper
// that mounts the real routes at a given URL with an authenticated session.

import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { AppRoutes } from '../App'
import { AuthProvider } from '../lib/auth'
import { ThemeProvider } from '../lib/theme'
import type { Org, Session } from '../lib/types'

export type Handler = (req: { method: string; url: string; body: unknown }) => unknown | [number, unknown]

export interface FetchLog {
  calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>
}

/** Installs a fetch mock. Keys are "METHOD /path" (query string ignored) or "METHOD /path?query". */
export function mockFetch(routes: Record<string, Handler>): FetchLog {
  const log: FetchLog = { calls: [] }
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    log.calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> })
    const handler = routes[`${method} ${url}`] ?? routes[`${method} ${url.split('?')[0]}`]
    if (!handler) return new Response(JSON.stringify({ error: `unmocked ${method} ${url}` }), { status: 404 })
    const out = handler({ method, url, body })
    const [status, payload] = Array.isArray(out) && typeof out[0] === 'number' ? (out as [number, unknown]) : [200, out]
    return new Response(status === 204 ? null : JSON.stringify(payload), { status })
  })
  return log
}

/** Minimal EventSource: tests push events with FakeEventSource.emit(urlPart, type, data). */
export class FakeEventSource {
  static instances: FakeEventSource[] = []
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>()
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, l: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(l)
  }
  removeEventListener(type: string, l: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(l)
  }
  close() {
    this.closed = true
  }
  static emit(urlPart: string, type: string, data: unknown) {
    for (const es of FakeEventSource.instances.filter((x) => x.url.includes(urlPart) && !x.closed)) {
      for (const l of es.listeners.get(type) ?? []) l(new MessageEvent(type, { data: JSON.stringify(data) }))
    }
  }
}

export const SESSION: Session = {
  user: { id: 'u1', email: 'kv@example.com', displayName: 'KV', createdAt: '2026-10-01T00:00:00Z' },
  orgs: [{ id: 'o1', slug: 'acme', name: 'Acme', plan: 'free', role: 'owner' }],
  csrfToken: 'csrf-token',
}

export const ORG: Org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme',
  plan: 'free',
  role: 'owner',
  createdAt: '2026-10-01T00:00:00Z',
  limits: { maxConcurrentRuns: 2, maxRunningEnvironments: 1, agentMinutesPerDay: 120, dailyBudgetUsd: null },
}

export const EMPTY_INBOX = { approvals: [], failures: [], live: [], upcoming: [] }

/** Routes every console page needs (session, org, nav badge, dock). */
export function baseRoutes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => SESSION,
    'GET /api/orgs/acme': () => ({ org: ORG }),
    'GET /api/orgs/acme/inbox': () => EMPTY_INBOX,
    'GET /api/orgs/acme/hosts': () => ({ hosts: [] }),
    'GET /api/orgs/acme/environments': () => ({ environments: [] }),
    ...overrides,
  }
}

export function renderAt(path: string) {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  )
}
