// ─────────────────────────────────────────────────────────────────────────────
// GitHub REST: open a pull request for an agent's pushed branch.
// Called from the worker (never from inside the agent container), using the
// org's GitHub integration token.
// ─────────────────────────────────────────────────────────────────────────────

import type { FetchFn } from './providers.js'

export interface PullRequest {
  url: string
  number: number
}

/** owner/repo from https://github.com/owner/repo(.git). Null for non-GitHub URLs. */
export function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  let u: URL
  try {
    u = new URL(repoUrl)
  } catch {
    return null
  }
  if (u.hostname !== 'github.com') return null
  const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(u.pathname)
  return m ? { owner: m[1]!, repo: m[2]! } : null
}

export async function createPullRequest(
  token: string,
  pr: { owner: string; repo: string; head: string; base: string; title: string; body: string },
  fetchImpl: FetchFn = fetch as FetchFn,
): Promise<PullRequest> {
  const res = await fetchImpl(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Routini/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ title: pr.title, head: pr.head, base: pr.base, body: pr.body }),
  })
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // non-JSON error body
  }
  if (res.status !== 201) {
    const detail = typeof body['message'] === 'string' ? `: ${body['message']}` : ''
    throw new Error(`GitHub refused the pull request (HTTP ${res.status}${detail})`)
  }
  return { url: String(body['html_url']), number: Number(body['number']) }
}
