// ─────────────────────────────────────────────────────────────────────────────
// Integration catalog — the single definition of every connector Routini knows.
//
// Each field's secret is stored in the org credential store under
// `integration.<id>.<field>`. `env` names the variable the field is injected as
// into agent containers whose agent is in the integration's scope.
// Live connection checks live in ./providers.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_IDS = ['claude', 'omnimancer', 'opencode'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export interface IntegrationField {
  key: string
  label: string
  secret: boolean
  env: string
}

/**
 * How the credential broker presents a secret field to a host, so containers
 * only ever hold a placeholder. `host` is fixed, or taken from a URL field.
 */
export interface BrokerRule {
  host?: string
  hostFromField?: string
  header: string
  format: 'bearer' | 'raw' | 'basic-token' | 'basic-pair'
  /** The secret field. */
  field: string
  /** For basic-pair: the field holding the user name. */
  userField?: string
}

export interface IntegrationDef {
  id: string
  name: string
  description: string
  setupUrl: string
  setupLabel: string
  fields: readonly IntegrationField[]
  broker?: readonly BrokerRule[]
  /** Not injected into agent containers (used by Routini itself, e.g. Factory). */
  serverOnly?: boolean
}

export interface IntegrationScopes {
  /** Agents whose containers receive this integration's env vars. */
  agents: AgentId[]
}

export const DEFAULT_SCOPES: IntegrationScopes = { agents: [...AGENT_IDS] }

export const INTEGRATIONS: readonly IntegrationDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repository access for agents, and pull requests for their results.',
    setupUrl: 'https://github.com/settings/personal-access-tokens/new',
    setupLabel: 'Create a fine-grained token',
    fields: [{ key: 'token', label: 'Personal access token', secret: true, env: 'GITHUB_TOKEN' }],
    broker: [
      { host: 'github.com', header: 'authorization', format: 'basic-token', field: 'token' },
      { host: 'api.github.com', header: 'authorization', format: 'bearer', field: 'token' },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Post to and read from Slack channels.',
    setupUrl: 'https://api.slack.com/apps',
    setupLabel: 'Create a Slack app',
    fields: [{ key: 'botToken', label: 'Bot token', secret: true, env: 'SLACK_BOT_TOKEN' }],
    broker: [{ host: 'slack.com', header: 'authorization', format: 'bearer', field: 'botToken' }],
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Jira Cloud issue tracking.',
    setupUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    setupLabel: 'Create an API token',
    fields: [
      { key: 'siteUrl', label: 'Site URL', secret: false, env: 'JIRA_SITE_URL' },
      { key: 'email', label: 'Account email', secret: false, env: 'JIRA_EMAIL' },
      { key: 'apiToken', label: 'API token', secret: true, env: 'JIRA_API_TOKEN' },
    ],
    broker: [{ hostFromField: 'siteUrl', header: 'authorization', format: 'basic-pair', field: 'apiToken', userField: 'email' }],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Notion workspace pages and databases.',
    setupUrl: 'https://www.notion.so/my-integrations',
    setupLabel: 'Create an internal integration',
    fields: [{ key: 'token', label: 'Internal integration token', secret: true, env: 'NOTION_TOKEN' }],
    broker: [{ host: 'api.notion.com', header: 'authorization', format: 'bearer', field: 'token' }],
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Linear issue tracking.',
    setupUrl: 'https://linear.app/settings/api',
    setupLabel: 'Create an API key',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, env: 'LINEAR_API_KEY' }],
    broker: [{ host: 'api.linear.app', header: 'authorization', format: 'raw', field: 'apiKey' }],
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'monday.com boards and items.',
    setupUrl: 'https://monday.com/developers/apps',
    setupLabel: 'Create a monday.com app',
    fields: [{ key: 'apiToken', label: 'API token', secret: true, env: 'MONDAY_TOKEN' }],
    broker: [{ host: 'api.monday.com', header: 'authorization', format: 'raw', field: 'apiToken' }],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'HubSpot CRM.',
    setupUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    setupLabel: 'Create a private app',
    fields: [{ key: 'token', label: 'Private app token', secret: true, env: 'HUBSPOT_TOKEN' }],
    broker: [{ host: 'api.hubapi.com', header: 'authorization', format: 'bearer', field: 'token' }],
  },
  {
    id: 'factory',
    name: 'Factory',
    description: 'Start Factory orchestrations and PRD executions from jobs, and wait for their results.',
    setupUrl: 'https://factory-nexus.ai',
    setupLabel: 'Create a Factory API key (fk_…)',
    fields: [
      { key: 'baseUrl', label: 'Factory URL', secret: false, env: 'FACTORY_SERVER' },
      { key: 'apiToken', label: 'API key', secret: true, env: 'FACTORY_API_KEY' },
    ],
    serverOnly: true,
  },
]

export function getIntegrationDef(id: string): IntegrationDef | undefined {
  return INTEGRATIONS.find((d) => d.id === id)
}

export function fieldCredentialKey(id: string, field: string): string {
  return `integration.${id}.${field}`
}

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v)
}

/** Validates a scopes payload; throws with a client-safe message. */
export function parseScopes(raw: unknown): IntegrationScopes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scopes must be an object')
  const agents = (raw as Record<string, unknown>)['agents']
  if (!Array.isArray(agents) || !agents.every(isAgentId)) {
    throw new Error(`scopes.agents must be an array of: ${AGENT_IDS.join(', ')}`)
  }
  return { agents: [...new Set(agents)] }
}
