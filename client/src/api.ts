/**
 * Auth-aware API fetch utilities for the Routini client.
 *
 * Session architecture:
 *  - The JWT travels in an HTTP-only SameSite=Strict cookie set by the server.
 *    It is never accessible to JavaScript, protecting it from XSS token theft.
 *  - The CSRF token is returned in the login response body, stored in
 *    sessionStorage, and sent as the X-CSRF-Token header on state-changing
 *    requests (POST, PUT, PATCH, DELETE). This implements the Double-Submit
 *    Cookie pattern without server-side CSRF state.
 *  - For programmatic / test clients using Bearer tokens the server accepts
 *    the Authorization header directly (CSRF not required for Bearer auth).
 *
 * Why sessionStorage for the CSRF token?
 *  - The JWT itself is in an HTTP-only cookie and is never exposed to JS.
 *  - The CSRF token must be JS-readable so it can be injected as a header.
 *  - sessionStorage is cleared when the browser tab closes, limiting exposure.
 *  - Cross-origin scripts cannot read sessionStorage, so the CSRF token is
 *    safe from cross-site attacks even though it lives in JS-accessible storage.
 */

/** HTTP methods that do not mutate state and do not require a CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

// ── CSRF token management ─────────────────────────────────────────

/** Returns the CSRF token stored after a successful login, or null. */
export function getCsrfToken(): string | null {
  return sessionStorage.getItem('csrfToken')
}

/** Persists the CSRF token received from the server's login response. */
export function setCsrfToken(token: string): void {
  sessionStorage.setItem('csrfToken', token)
}

/** Removes the CSRF token (call on logout to clear client-side auth state). */
export function clearCsrfToken(): void {
  sessionStorage.removeItem('csrfToken')
}

// ── Auth state helpers ────────────────────────────────────────────

/**
 * Returns a truthy value when the user appears to be authenticated.
 * The presence of a CSRF token in sessionStorage is used as the proxy:
 * it is set on login and cleared on logout, matching the cookie lifecycle.
 *
 * Note: this is a client-side optimistic check. The server always re-validates
 * the JWT cookie on every protected request.
 */
export function getToken(): string | null {
  return getCsrfToken()
}

/**
 * Clears all client-side auth artifacts.
 * The HTTP-only session cookie is cleared by the server's logout endpoint.
 */
export function clearToken(): void {
  clearCsrfToken()
}

// ── Fetch wrapper ─────────────────────────────────────────────────

/**
 * Wrapper around fetch that:
 *  1. Always includes credentials so the HTTP-only session cookie is sent.
 *  2. Injects the X-CSRF-Token header for state-changing requests when a
 *     CSRF token is available in sessionStorage.
 *  3. Handles 401 responses centrally: clears local auth state and redirects
 *     the browser to /login so the user can re-authenticate cleanly. This
 *     mirrors the original guardFetch pattern and prevents silently broken
 *     UI when a session expires mid-visit.
 *
 * Caller-supplied headers take precedence and may override the CSRF header
 * if needed.
 */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const csrfToken = getCsrfToken()

  // Only inject the CSRF header for state-changing (non-safe) methods.
  const csrfHeaders: HeadersInit =
    !SAFE_METHODS.has(method) && csrfToken
      ? { 'X-CSRF-Token': csrfToken }
      : {}

  const res = await fetch(url, {
    ...init,
    // 'include' sends the HTTP-only session cookie on every request,
    // including cross-origin requests (within the same site in production).
    credentials: 'include',
    headers: {
      ...csrfHeaders,
      ...init?.headers,
    },
  })

  // Centralized 401 handling: session has expired or is invalid.
  // Clear the CSRF token so that Protected routes redirect to /login on the
  // next render, and force a hard navigation so no broken auth state remains.
  // location.replace keeps /login out of the browser history stack.
  if (res.status === 401) {
    clearCsrfToken()
    // Guard against non-browser environments (SSR, tests).
    if (typeof window !== 'undefined') {
      window.location.replace('/login')
    }
  }

  return res
}

/**
 * Returns auth headers for legacy / compatibility callers.
 * With cookie-based auth the browser sends the cookie automatically via
 * credentials:'include', so no explicit Authorization header is needed.
 */
export function getAuthHeaders(): HeadersInit {
  return {}
}
