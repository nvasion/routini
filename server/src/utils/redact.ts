// ─────────────────────────────────────────────────────────────────────────────
// Secret redaction for anything that is persisted or streamed to clients
// (run events, step output, error messages).
//
// Two layers:
//   1. Exact values: every secret the server handed to a step (credentials,
//      API keys, integration tokens) is replaced wherever it appears. This is
//      the reliable layer — pattern matching cannot know arbitrary secrets.
//   2. Patterns: common credential shapes (Bearer tokens, sk-… keys, URI
//      passwords, key=value pairs) as a backstop for secrets we never saw.
// ─────────────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\b(sk|pk|api|key)-[A-Za-z0-9_-]{8,}/gi, '[REDACTED]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/(:\/\/[^:@\s/]+:)[^@\s]+(@)/g, '$1[REDACTED]$2'],
  [/\b(password|passwd|secret|token|api_key|apikey)\s*[=:]\s*\S+/gi, '$1=[REDACTED]'],
]

/** Values shorter than this are not redacted by exact match (too likely to hit ordinary text). */
const MIN_EXACT_LEN = 6

export function redact(text: string, knownSecrets: Iterable<string> = []): string {
  let out = text
  const exact = [...knownSecrets].filter((s) => s.length >= MIN_EXACT_LEN).sort((a, b) => b.length - a.length)
  for (const s of exact) out = out.split(s).join('[REDACTED]')
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

/** Redacts every string inside a JSON-compatible value. */
export function redactDeep<T>(value: T, knownSecrets: Iterable<string> = []): T {
  const secrets = [...knownSecrets]
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v, secrets)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return walk(value) as T
}
