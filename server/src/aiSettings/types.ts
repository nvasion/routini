/**
 * Types for the per-user AI settings feature.
 *
 * Users configure their preferred AI provider, an API key for that provider,
 * and a default agent used when a developmental task is created without an
 * explicit agent selection.
 */

import type { AgentName } from '../tasks/types.js'

/**
 * Providers the settings panel can select. Kept intentionally aligned with the
 * agents catalog — the provider tells the system which API to hit; the
 * default agent tells the developmental-task pipeline which local runner to
 * spin up. They happen to share names today but may diverge as providers
 * grow (e.g. a single provider hosting multiple agents).
 */
export type AiProvider = 'opencode' | 'claude-code' | 'omnimancer'

export const VALID_AI_PROVIDERS: AiProvider[] = [
  'opencode',
  'claude-code',
  'omnimancer',
]

/**
 * Model-parameter tunables. Every field is optional so a client can persist
 * only the values they care about. Ranges are documented alongside the
 * validator so the constants live in one place.
 */
export interface AiModelParameters {
  /** Model identifier (e.g. `"claude-4.5-sonnet"`). */
  model: string | null
  /** Sampling temperature — 0.0 to 2.0. */
  temperature: number | null
  /** Maximum tokens to generate — 1 to 200_000. */
  maxTokens: number | null
}

/**
 * Public shape returned to the client. Note the intentional absence of any
 * field carrying the raw API key — the API only surfaces a boolean flag so
 * callers can render "configured / not configured" without ever holding the
 * secret in browser memory.
 */
export interface AiSettingsView extends AiModelParameters {
  provider: AiProvider | null
  defaultAgent: AgentName | null
  /** True when an API key is currently stored for this user. */
  hasApiKey: boolean
  updatedAt: string
}

/**
 * Input body accepted by `PUT /api/settings/ai`. All fields are optional —
 * only supplied fields are updated. Special semantics for clearing a value
 * (setting it back to "unset") depend on the field:
 *
 *  - `provider` / `defaultAgent`: send `null` explicitly to clear.
 *  - `apiKey`: send `null` explicitly to clear; omit to leave unchanged; send
 *    a non-empty string to replace.
 *  - `model` / `temperature` / `maxTokens`: send `null` to clear; omit to
 *    leave unchanged.
 */
export interface UpdateAiSettingsInput {
  provider?: AiProvider | null
  apiKey?: string | null
  defaultAgent?: AgentName | null
  model?: string | null
  temperature?: number | null
  maxTokens?: number | null
}
