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
  format: 'bearer' | 'raw' | 'basic-token' | 'basic-pair' | 'token'
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
  /** Listed but not connectable yet (shown as "Coming soon"). */
  comingSoon?: boolean
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
    id: 'azure-devops',
    name: 'Azure DevOps',
    description: 'Azure Boards work items, Repos and Pipelines. Jobs can read a board with the Azure Boards step.',
    setupUrl: 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
    setupLabel: 'Create a personal access token (Work Items: Read)',
    fields: [
      { key: 'organization', label: 'Organization (dev.azure.com/<name>)', secret: false, env: 'AZURE_DEVOPS_ORG' },
      { key: 'pat', label: 'Personal access token', secret: true, env: 'AZURE_DEVOPS_EXT_PAT' },
    ],
    broker: [
      { host: 'dev.azure.com', header: 'authorization', format: 'basic-token', field: 'pat' },
      { host: 'vssps.dev.azure.com', header: 'authorization', format: 'basic-token', field: 'pat' },
    ],
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    description: 'Post messages to a Teams channel from jobs with the Teams step. Test connection posts a short message to the channel.',
    setupUrl: 'https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498',
    setupLabel: 'Create a Workflows webhook',
    fields: [{ key: 'webhookUrl', label: 'Workflows webhook URL', secret: true, env: 'TEAMS_WEBHOOK_URL' }],
    serverOnly: true,
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'GitLab projects, merge requests and issues (gitlab.com or your own instance).',
    setupUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    setupLabel: 'Create a personal access token',
    fields: [
      { key: 'baseUrl', label: 'GitLab URL (https://gitlab.com or your instance)', secret: false, env: 'GITLAB_URL' },
      { key: 'token', label: 'Personal access token', secret: true, env: 'GITLAB_TOKEN' },
    ],
    broker: [{ hostFromField: 'baseUrl', header: 'private-token', format: 'raw', field: 'token' }],
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    description: 'Droplets, App Platform, databases and DNS on DigitalOcean (doctl and the API).',
    setupUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    setupLabel: 'Create a personal access token',
    fields: [{ key: 'token', label: 'Personal access token', secret: true, env: 'DIGITALOCEAN_ACCESS_TOKEN' }],
    broker: [{ host: 'api.digitalocean.com', header: 'authorization', format: 'bearer', field: 'token' }],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Sentry issues and events, so agents can read the stack trace behind a failure.',
    setupUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    setupLabel: 'Create an auth token',
    fields: [{ key: 'token', label: 'Auth token', secret: true, env: 'SENTRY_AUTH_TOKEN' }],
    broker: [
      { host: 'sentry.io', header: 'authorization', format: 'bearer', field: 'token' },
      { host: 'us.sentry.io', header: 'authorization', format: 'bearer', field: 'token' },
      { host: 'de.sentry.io', header: 'authorization', format: 'bearer', field: 'token' },
    ],
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    description: 'PagerDuty incidents and on-call: acknowledge, annotate and resolve from runbooks.',
    setupUrl: 'https://support.pagerduty.com/main/docs/api-access-keys',
    setupLabel: 'Create a REST API key',
    fields: [{ key: 'apiKey', label: 'REST API key', secret: true, env: 'PAGERDUTY_TOKEN' }],
    broker: [{ host: 'api.pagerduty.com', header: 'authorization', format: 'token', field: 'apiKey' }],
  },
  {
    id: 'datadog',
    name: 'Datadog',
    description: 'Datadog metrics, logs and monitors for diagnosing incidents.',
    setupUrl: 'https://app.datadoghq.com/organization-settings/api-keys',
    setupLabel: 'Create an API key and an application key',
    fields: [
      { key: 'apiUrl', label: 'API URL (https://api.datadoghq.com, https://api.datadoghq.eu, ...)', secret: false, env: 'DATADOG_API_URL' },
      { key: 'apiKey', label: 'API key', secret: true, env: 'DD_API_KEY' },
      { key: 'appKey', label: 'Application key', secret: true, env: 'DD_APP_KEY' },
    ],
    broker: [
      { hostFromField: 'apiUrl', header: 'dd-api-key', format: 'raw', field: 'apiKey' },
      { hostFromField: 'apiUrl', header: 'dd-application-key', format: 'raw', field: 'appKey' },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Cloudflare DNS, Workers and cache: purge, route and inspect.',
    setupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    setupLabel: 'Create an API token',
    fields: [{ key: 'token', label: 'API token', secret: true, env: 'CLOUDFLARE_API_TOKEN' }],
    broker: [{ host: 'api.cloudflare.com', header: 'authorization', format: 'bearer', field: 'token' }],
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
  {
    id: 'ttyy',
    name: 'ttyy.ai',
    description: 'AI SRE platform. Hand incidents and on-call toil to ttyy agents and get the fix back as a runbook.',
    setupUrl: 'https://ttyy.ai',
    setupLabel: 'Learn more',
    fields: [],
    serverOnly: true,
    comingSoon: true,
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
