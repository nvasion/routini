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
// ─────────────────────────────────────────────────────────────────────────────

import type { Step } from './spec.js'

export interface TemplateData {
  alert?: Record<string, unknown>
  incident?: Record<string, unknown>
  host?: Record<string, unknown>
  /** Earlier steps' outputs, by step id. */
  steps?: Record<string, unknown>
  trigger?: Record<string, unknown>
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g
const ROOTS = new Set(['alert', 'incident', 'host', 'steps', 'trigger'])

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
        return {
          ...step,
          config: {
            ...c,
            url: renderText(c.url, data, 'url'),
            body: c.body === undefined ? undefined : renderText(c.body, data),
            headers: c.headers ? Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, renderText(v, data)])) : undefined,
          },
        }
      }
      if (c.type === 'ssh') {
        if (!hasPlaceholders(c.command)) return step
        const env: Record<string, string> = { ...(c.env ?? {}) }
        return { ...step, config: { ...c, command: renderCommand(c.command, data, env), env } }
      }
      if (c.type === 'factory' && c.request) return { ...step, config: { ...c, request: renderText(c.request, data) } }
      return step
    }
    case 'agent':
      return { ...step, config: { ...step.config, prompt: renderText(step.config.prompt, data) } }
    case 'approval':
      return { ...step, config: { ...step.config, message: renderText(step.config.message, data) } }
  }
}
