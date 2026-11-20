// ─────────────────────────────────────────────────────────────────────────────
// Runbook templating: `{{alert.labels.instance}}`, `{{steps.diag.stdout}}` …
//
// Values are untrusted (alert labels come from whatever is being monitored), so
// how a value is inserted depends on where it lands:
//   commands  → never spliced into the shell text. Each value becomes an
//               environment variable and the placeholder becomes "$ROUTINI_Tn".
//               Shell expansion of a variable is never re-parsed, so a label
//               like `x; rm -rf /` stays one argument, quoted or not.
//   URLs      → percent-encoded.
//   elsewhere → as is (prompts, messages, bodies, headers).
// Unknown paths render as an empty string.
//
// An http header may instead reference stored credentials, `Bearer
// {{credentials.<key>}}`, and nothing else. Such a header is never rendered
// with data: it moves to `credentialHeaders`, which the executor fills from the
// credential store. So text from a trigger can never name a credential.
// ─────────────────────────────────────────────────────────────────────────────

import type { Step } from './spec.js'

export interface TemplateData {
  alert?: Record<string, unknown>
  incident?: Record<string, unknown>
  host?: Record<string, unknown>
  /** Earlier steps' outputs, by step id. */
  steps?: Record<string, unknown>
  trigger?: Record<string, unknown>
  /** The backlog item a `backlog`-triggered run was leased to. */
  item?: Record<string, unknown>
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g
const ROOTS = new Set(['alert', 'incident', 'host', 'steps', 'trigger', 'item'])

export function lookup(data: TemplateData, path: string): string {
  const parts = path.split('.')
  if (!ROOTS.has(parts[0]!)) return ''
  let cur: unknown = data
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return ''
    cur = (cur as Record<string, unknown>)[p]
  }
  if (cur === null || cur === undefined) return ''
  return typeof cur === 'object' ? JSON.stringify(cur) : String(cur)
}

export function hasPlaceholders(s: string): boolean {
  PLACEHOLDER.lastIndex = 0
  return PLACEHOLDER.test(s)
}

/** The paths a string's placeholders name, in order. */
export function placeholderPaths(s: string): string[] {
  return [...s.matchAll(PLACEHOLDER)].map((m) => m[1]!)
}

const CREDENTIALS = 'credentials.'

/** The credential keys a string references as `{{credentials.<key>}}`. */
export function credentialKeys(s: string): string[] {
  return placeholderPaths(s)
    .filter((p) => p.startsWith(CREDENTIALS))
    .map((p) => p.slice(CREDENTIALS.length))
}

/** Fills `{{credentials.<key>}}` placeholders, or names the first key `resolve` has no value for. */
export async function fillCredentials(s: string, resolve: (key: string) => Promise<string | null>): Promise<{ value: string } | { missing: string }> {
  const values = new Map<string, string>()
  for (const key of credentialKeys(s)) {
    const v = await resolve(key)
    if (v === null) return { missing: key }
    values.set(key, v)
  }
  return { value: s.replace(PLACEHOLDER, (_, path: string) => values.get(path.slice(CREDENTIALS.length)) ?? '') }
}

export function renderText(s: string, data: TemplateData, mode: 'raw' | 'url' = 'raw'): string {
  return s.replace(PLACEHOLDER, (_, path: string) => {
    const v = lookup(data, path)
    return mode === 'url' ? encodeURIComponent(v) : v
  })
}

/** Command text: placeholders become "$ROUTINI_Tn"; values go in `env`. */
export function renderCommand(s: string, data: TemplateData, env: Record<string, string>): string {
  return s.replace(PLACEHOLDER, (_, path: string) => {
    const name = `ROUTINI_T${Object.keys(env).length + 1}`
    env[name] = lookup(data, path)
    return `"$${name}"`
  })
}

/** Exports for shells without an env channel (SSH): values single-quoted by us, before the user's command. */
export function shellExports(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `)
    .join('')
}

/**
 * Renders the templated fields of a step. Only text fields are templated;
 * ids, hosts and repositories never are.
 */
export function renderStep(step: Step, data: TemplateData): Step {
  switch (step.kind) {
    case 'action': {
      const c = step.config
      if (c.type === 'http') {
        const headers = Object.entries(c.headers ?? {})
        const withCredentials = headers.filter(([, v]) => credentialKeys(v).length > 0)
        const plain = headers.filter(([, v]) => credentialKeys(v).length === 0)
        return {
          ...step,
          config: {
            ...c,
            url: renderText(c.url, data, 'url'),
            body: c.body === undefined ? undefined : renderText(c.body, data),
            headers: c.headers ? Object.fromEntries(plain.map(([k, v]) => [k, renderText(v, data)])) : undefined,
            credentialHeaders: withCredentials.length ? Object.fromEntries(withCredentials) : undefined,
          },
        }
      }
      if (c.type === 'ssh') {
        if (!hasPlaceholders(c.command)) return step
        const env: Record<string, string> = { ...(c.env ?? {}) }
        return { ...step, config: { ...c, command: renderCommand(c.command, data, env), env } }
      }
      if (c.type === 'factory') {
        return {
          ...step,
          config: {
            ...c,
            request: c.request ? renderText(c.request, data) : c.request,
            projectId: c.projectId ? renderText(c.projectId, data) : c.projectId,
            repoUrl: c.repoUrl ? renderText(c.repoUrl, data) : c.repoUrl,
          },
        }
      }
      if (c.type === 'azure-boards') {
        if (c.query === undefined) return step
        return { ...step, config: { ...c, query: renderText(c.query, data) } }
      }
      if (c.type === 'teams') {
        return { ...step, config: { ...c, message: renderText(c.message, data), title: c.title === undefined ? undefined : renderText(c.title, data) } }
      }
      return step
    }
    case 'agent':
      return { ...step, config: { ...step.config, prompt: renderText(step.config.prompt, data) } }
    case 'approval':
      return { ...step, config: { ...step.config, message: renderText(step.config.message, data) } }
  }
}
