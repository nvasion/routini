// ─────────────────────────────────────────────────────────────────────────────
// The newest routini-runner release, for the console's "Update runner" button.
//
//   ROUTINI_RUNNER_LATEST_VERSION=v0.3.1   pin it (air-gapped installs, tests)
//   ROUTINI_RUNNER_RELEASES=off            never ask GitHub (no update offers)
//
// Otherwise GitHub's releases API is asked, at most once an hour; a failure is
// remembered for five minutes so a slow GitHub never slows the console down.
// ─────────────────────────────────────────────────────────────────────────────

export const RUNNER_RELEASES_URL = 'https://api.github.com/repos/nvasion/routini-runner/releases/latest'

const TAG_RE = /^v\d+\.\d+\.\d+$/
const OK_TTL_MS = 60 * 60 * 1000
const FAIL_TTL_MS = 5 * 60 * 1000
const TIMEOUT_MS = 5000

export interface RunnerReleases {
  /** The latest release tag (vX.Y.Z), or null when it is unknown. */
  latest(): Promise<string | null>
}

/** Accepts "0.3.1" or "v0.3.1"; null for anything that is not a release tag. */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim().startsWith('v') ? raw.trim() : `v${raw.trim()}`
  return TAG_RE.test(t) ? t : null
}

/** Compares two release tags; negative when a is older than b. */
export function compareTags(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export function runnerReleasesFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): RunnerReleases {
  const pinned = env['ROUTINI_RUNNER_LATEST_VERSION']?.trim()
  if (pinned) {
    const tag = normalizeTag(pinned)
    if (!tag) throw new Error(`ROUTINI_RUNNER_LATEST_VERSION must look like v1.2.3 (got "${pinned}")`)
    return { latest: async () => tag }
  }
  if (env['ROUTINI_RUNNER_RELEASES']?.trim() === 'off') return { latest: async () => null }

  let cached: { tag: string | null; until: number } | null = null
  let inflight: Promise<string | null> | null = null
  const ask = async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(RUNNER_RELEASES_URL, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'routini' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const tag = res.ok ? normalizeTag(((await res.json()) as { tag_name?: unknown }).tag_name) : null
      cached = { tag, until: now() + (tag ? OK_TTL_MS : FAIL_TTL_MS) }
      return tag
    } catch {
      cached = { tag: null, until: now() + FAIL_TTL_MS }
      return null
    }
  }
  return {
    async latest() {
      if (cached && cached.until > now()) return cached.tag
      inflight ??= ask().finally(() => (inflight = null))
      return inflight
    },
  }
}
