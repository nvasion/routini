// The org in the URL (/o/:org/…): its details, my role, and role checks.

import { createContext, useContext, type ReactNode } from 'react'
import { useApi } from '../lib/hooks'
import { orgApi } from '../lib/api'
import type { Org, Role } from '../lib/types'

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

interface OrgState {
  slug: string
  org: Org | null
  /** True when my role is at least `min`. */
  can(min: Role): boolean
  reload(): Promise<void>
  /** Path inside this org's console: path('/runs/3') → /o/acme/runs/3 */
  path(p: string): string
  /** API path for this org: api('/runs') → /api/orgs/acme/runs */
  api(p?: string): string
}

const OrgCtx = createContext<OrgState | null>(null)

export function OrgProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const { data, reload, error } = useApi<{ org: Org }>(orgApi(slug))
  const org = data?.org ?? null
  const value: OrgState = {
    slug,
    org,
    can: (min) => (org ? RANK[org.role] >= RANK[min] : false),
    reload,
    path: (p) => `/o/${slug}${p}`,
    api: (p = '') => orgApi(slug, p),
  }
  if (error) {
    return (
      <div className="main">
        <div className="banner">{error === 'Org not found' ? 'This org does not exist or you are not a member.' : error}</div>
      </div>
    )
  }
  return <OrgCtx.Provider value={value}>{children}</OrgCtx.Provider>
}

export function useOrg(): OrgState {
  const ctx = useContext(OrgCtx)
  if (!ctx) throw new Error('useOrg outside OrgProvider')
  return ctx
}
