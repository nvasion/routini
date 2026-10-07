// ─────────────────────────────────────────────────────────────────────────────
// Azure DevOps: shared helpers for authenticating against the Azure DevOps
// Services REST API with a user-supplied Personal Access Token (PAT).
// Azure DevOps uses HTTP Basic auth with an empty username and the PAT as the
// password — there is no OAuth bearer flow for PAT-based access.
// ─────────────────────────────────────────────────────────────────────────────

/** REST API version pinned for all Azure DevOps requests. */
export const ADO_API_VERSION = '7.1'

/**
 * Azure DevOps organization names: 1-50 characters, alphanumeric, may contain
 * interior hyphens (not leading/trailing). Matches the portal's own rules.
 */
export const ADO_ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/

/** True when `org` is a syntactically valid Azure DevOps organization name. */
export function isValidAdoOrganization(org: string): boolean {
  return ADO_ORG_RE.test(org)
}

/** Basic-auth header value for a PAT: empty username, PAT as password. */
export function adoAuthHeader(pat: string): string {
  return 'Basic ' + Buffer.from(`:${pat}`, 'utf8').toString('base64')
}

/** Base REST URL for an Azure DevOps organization. */
export function adoBaseUrl(org: string): string {
  return `https://dev.azure.com/${encodeURIComponent(org)}`
}
