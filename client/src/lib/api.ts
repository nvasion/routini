// Fetch wrapper for the Routini API. Browser sessions use the HTTP-only
// cookie; mutations echo the CSRF token the server handed us.

let csrfToken: string | null = null
try {
  csrfToken = sessionStorage.getItem('routini.csrf')
} catch {
  csrfToken = null
}

export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token ?? null
  try {
    if (csrfToken) sessionStorage.setItem('routini.csrf', csrfToken)
    else sessionStorage.removeItem('routini.csrf')
  } catch {
    // storage unavailable (private mode); the in-memory token still works
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The response body, for errors that carry more than a message. */
    readonly data: unknown = null,
  ) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  if (res.status === 204) return undefined as T
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status})`
    throw new ApiError(res.status, msg, data)
  }
  return data as T
}

/** Org-scoped path helper: orgPath('acme', '/runs') → /api/orgs/acme/runs */
export const orgApi = (org: string, path = '') => `/api/orgs/${encodeURIComponent(org)}${path}`
