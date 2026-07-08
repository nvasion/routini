/**
 * Auth API client. All requests use `credentials: 'include'` so the browser
 * attaches the HttpOnly auth cookie. Keeping this narrow — one helper per
 * endpoint — lets the auth context stay dumb.
 */

export interface AuthUser {
  id: string
  username: string
  createdAt: string
}

interface LoginResponse {
  user: AuthUser
  expiresInSeconds: number
}

interface SessionResponse {
  user: AuthUser | null
}

interface ErrorResponse {
  error?: string
}

export class AuthApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AuthApiError'
    this.status = status
  }
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as ErrorResponse
    if (body && typeof body.error === 'string' && body.error.length > 0) {
      return body.error
    }
  } catch {
    // Response wasn't JSON — fall through to the default message.
  }
  return fallback
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const message = await readErrorMessage(res, 'Login failed')
    throw new AuthApiError(res.status, message)
  }
  const body = (await res.json()) as LoginResponse
  return body.user
}

export async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
    // Content-Type: application/json satisfies the server's CSRF check for
    // state-changing endpoints, even though this call has no request body.
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const message = await readErrorMessage(res, 'Logout failed')
    throw new AuthApiError(res.status, message)
  }
}

export async function fetchSession(): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/session', { credentials: 'include' })
  if (!res.ok) {
    const message = await readErrorMessage(res, 'Failed to load session')
    throw new AuthApiError(res.status, message)
  }
  const body = (await res.json()) as SessionResponse
  return body.user
}
