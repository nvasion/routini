// Org policy storage (tenant table). Orgs without a row get the mode's defaults.

import type { Queryable } from '../db/index.js'
import { defaultRules, type PolicyRule } from '../engine/policy.js'

export interface EgressSettings {
  /** Hostnames (or "*.suffix" patterns) agents may reach through the broker. */
  allowedHosts: string[]
}

export interface OrgPolicy {
  rules: PolicyRule[]
  egress: EgressSettings
  updatedAt: string | null
  isDefault: boolean
}

/** Model endpoints, git hosts and common package registries. */
export const DEFAULT_EGRESS_HOSTS = [
  'api.anthropic.com',
  'openrouter.ai',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
]

export async function getPolicy(q: Queryable, orgId: string, mode: 'selfhost' | 'hosted'): Promise<OrgPolicy> {
  const [row] = await q.query<{ rules: PolicyRule[]; egress: Partial<EgressSettings>; updated_at: Date }>(
    'SELECT rules, egress, updated_at FROM org_policies WHERE org_id = $1',
    [orgId],
  )
  if (!row) return { rules: defaultRules(mode), egress: { allowedHosts: [...DEFAULT_EGRESS_HOSTS] }, updatedAt: null, isDefault: true }
  return {
    rules: row.rules,
    egress: { allowedHosts: row.egress.allowedHosts ?? [...DEFAULT_EGRESS_HOSTS] },
    updatedAt: new Date(row.updated_at).toISOString(),
    isDefault: false,
  }
}

export async function savePolicy(q: Queryable, orgId: string, userId: string, p: { rules: PolicyRule[]; egress: EgressSettings }): Promise<void> {
  await q.query(
    `INSERT INTO org_policies (org_id, rules, egress, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id) DO UPDATE SET rules = excluded.rules, egress = excluded.egress, updated_by = excluded.updated_by, updated_at = now()`,
    [orgId, JSON.stringify(p.rules), JSON.stringify(p.egress), userId],
  )
}

/** Validates an egress allow-list: hostnames or "*.domain" wildcards. */
export function parseEgress(raw: unknown): EgressSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('egress must be an object')
  const hosts = (raw as Record<string, unknown>)['allowedHosts']
  if (!Array.isArray(hosts) || hosts.length > 500) throw new Error('egress.allowedHosts must be a list (at most 500)')
  const re = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
  const out: string[] = []
  for (const h of hosts) {
    const v = typeof h === 'string' ? h.trim().toLowerCase() : ''
    if (!re.test(v)) throw new Error(`egress.allowedHosts: "${String(h)}" is not a hostname or *.domain pattern`)
    out.push(v)
  }
  return { allowedHosts: [...new Set(out)] }
}

/** True when `host` is allowed by the list (exact, or a "*.suffix" match below it). */
export function hostAllowed(allowed: string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a))
}
