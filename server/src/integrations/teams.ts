// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Teams: posts a message to a Teams channel through a Power
// Automate / Workflows webhook ("Post to a channel when a webhook request is
// received"). The webhook URL is user-supplied, so it is validated against an
// allow-list of Microsoft webhook hosts before any request is made — this is
// the one SSRF exception documented in providers.ts for this integration.
// ─────────────────────────────────────────────────────────────────────────────

import type { FetchFn } from './providers.js'

/** Hostname suffixes used by Microsoft's webhook-receiving services. */
export const TEAMS_WEBHOOK_HOST_SUFFIXES = [
  '.logic.azure.com',
  '.webhook.office.com',
  '.powerplatform.com',
  '.powerautomate.com',
] as const

/**
 * Validates that `raw` is a well-formed, https, credential-free URL whose
 * host is a known Microsoft webhook host. Throws a client-safe `Error` on
 * any violation. Returns the parsed URL on success.
 */
export function validateTeamsWebhookUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Teams webhook URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Teams webhook URL must use https')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Teams webhook URL must not contain embedded credentials')
  }
  const hostname = parsed.hostname.toLowerCase()
  if (!TEAMS_WEBHOOK_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
    throw new Error('Teams webhook URL host is not a Microsoft webhook host')
  }
  return parsed
}

/** Builds the Adaptive Card payload the Workflows webhook trigger expects. */
export function teamsMessagePayload(text: string, title?: string): unknown {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            ...(title ? [{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true }] : []),
            { type: 'TextBlock', text, wrap: true },
          ],
        },
      },
    ],
  }
}

/**
 * Posts a message to a Teams webhook. Validates the URL first (lets that
 * Error propagate), then POSTs JSON with a bounded timeout that also aborts
 * when `opts.signal` aborts. Does not catch network errors — callers do.
 */
export async function postTeamsMessage(
  webhookUrl: string,
  msg: { text: string; title?: string },
  opts: { fetchImpl?: FetchFn; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; status: number }> {
  const target = validateTeamsWebhookUrl(webhookUrl)
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchFn)
  const timeoutMs = opts.timeoutMs ?? 15_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onExternalAbort)
  try {
    const res = await fetchImpl(target.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(teamsMessagePayload(msg.text, msg.title)),
      signal: controller.signal,
    })
    return { ok: res.status >= 200 && res.status < 300, status: res.status }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onExternalAbort)
  }
}
