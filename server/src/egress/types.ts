// Shared types between the egress proxy (egress/proxy.ts) and the worker-side
// broker client (egress/client.ts).

/** How a secret is presented to an upstream host. */
export type BindingFormat =
  | 'bearer' // Authorization: Bearer <secret>
  | 'raw' //    <header>: <secret>
  | 'basic-token' // Authorization: Basic base64("x-access-token:<secret>")  (git over https)
  | 'basic-pair' // Authorization: Basic base64("<user>:<secret>")
  | 'token' // Authorization: Token token=<secret>  (PagerDuty)

export interface CredentialBinding {
  host: string
  header: string
  format: BindingFormat
  secret: string
  /** For basic-pair. */
  user?: string
}

export interface EgressSession {
  token: string
  orgId: string
  /** Run id, or "env:<environmentId>" for an environment's own session. */
  label: string
  /** Hostnames or "*.suffix" patterns that may be reached. */
  allowedHosts: string[]
  bindings: CredentialBinding[]
  /** ISO time; the proxy drops the session afterwards. */
  expiresAt: string
}

export interface SessionStats {
  requests: number
  intercepted: number
  /** Hosts refused because they were not on the allow-list (deduplicated, in order). */
  blocked: string[]
}

/** Placeholder put in containers wherever a brokered secret would go. */
export const PLACEHOLDER = 'routini-brokered-credential'
