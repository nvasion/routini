/**
 * AI settings API client.
 *
 * Wraps the two endpoints the settings page needs — `GET` and `PUT
 * /api/settings/ai` — in a small, typed surface so the page component stays
 * focused on rendering. All requests use `credentials: 'include'` so the
 * HttpOnly auth cookie is attached.
 *
 * Redaction contract
 * ──────────────────
 * The API never returns the raw API key; the response includes only a
 * `hasApiKey` boolean. This module preserves that shape so the value is
 * neither cached nor round-tripped through client memory.
 */

export type AiProvider = 'opencode' | 'claude-code' | 'omnimancer'
export type AgentName = 'opencode' | 'claude-code' | 'omnimancer'

export const AI_PROVIDERS: AiProvider[] = ['opencode', 'claude-code', 'omnimancer']
export const AI_AGENTS: AgentName[] = ['opencode', 'claude-code', 'omnimancer']

export interface AiSettingsView {
  provider: AiProvider | null
  defaultAgent: AgentName | null
  hasApiKey: boolean
  model: string | null
  temperature: number | null
  maxTokens: number | null
  updatedAt: string
}

export interface UpdateAiSettingsInput {
  provider?: AiProvider | null
  apiKey?: string | null
  defaultAgent?: AgentName | null
  model?: string | null
  temperature?: number | null
  maxTokens?: number | null
}

interface ErrorBody {
  error?: string
  details?: string[]
}

export class AiSettingsApiError extends Error {
  readonly status: number
  readonly details: string[]

  constructor(status: number, message: string, details: string[] = []) {
    super(message)
    this.name = 'AiSettingsApiError'
    this.status = status
    this.details = details
  }
}

async function extractError(res: Response, fallback: string): Promise<AiSettingsApiError> {
  let body: ErrorBody | null = null
  try {
    body = (await res.json()) as ErrorBody
  } catch {
    /* fall through */
  }
  const message =
    body && typeof body.error === 'string' && body.error.length > 0 ? body.error : fallback
  const details = body && Array.isArray(body.details) ? body.details : []
  return new AiSettingsApiError(res.status, message, details)
}

export async function fetchAiSettings(): Promise<AiSettingsView> {
  const res = await fetch('/api/settings/ai', { credentials: 'include' })
  if (!res.ok) {
    throw await extractError(res, 'Failed to load AI settings')
  }
  return (await res.json()) as AiSettingsView
}

export async function updateAiSettings(
  patch: UpdateAiSettingsInput,
): Promise<AiSettingsView> {
  const res = await fetch('/api/settings/ai', {
    method: 'PUT',
    credentials: 'include',
    // application/json satisfies the server-side CSRF Content-Type guard.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    throw await extractError(res, 'Failed to update AI settings')
  }
  return (await res.json()) as AiSettingsView
}
