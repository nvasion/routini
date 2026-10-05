// API shapes, mirroring the server's responses (server/src/routes/*).

export type Role = 'owner' | 'admin' | 'member' | 'viewer'
export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled'
export type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'canceled'
export type StepKind = 'action' | 'agent' | 'approval'
export type AgentId = 'claude' | 'omnimancer' | 'opencode'

export interface User {
  id: string
  email: string
  displayName: string
  createdAt: string
}

export interface OrgRef {
  id: string
  slug: string
  name: string
  plan: string
  role: Role
}

export interface OrgLimits {
  maxConcurrentRuns: number
  maxRunningEnvironments: number
  agentMinutesPerDay: number | null
  dailyBudgetUsd: number | null
}

export interface Org extends OrgRef {
  limits: OrgLimits
  createdAt: string
  /** TynHub org slug whose members join on "Continue with TynHub". */
  tynhubOrg?: string | null
}

export interface Session {
  user: User
  orgs: OrgRef[]
  csrfToken?: string
}

export interface AlertMatch {
  alertnames?: string[]
  severities?: string[]
  labels?: Record<string, string>
}
export type Trigger = { kind: 'manual' } | { kind: 'cron'; expr: string; tz: string } | { kind: 'webhook' } | { kind: 'alert'; match: AlertMatch }
export type When = 'on_success' | 'on_failure' | 'always'

export type ActionConfig =
  | { type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string; expectStatus?: number; timeoutMs?: number }
  /** A command on a host (SSH or routini-runner). host: 'alert' targets the incident's host. */
  | { type: 'ssh'; hostId?: string; host?: 'alert'; command: string }
  | { type: 'imap'; host: string; port?: number; username: string; credentialKey: string; mailbox?: string; search?: string; tls?: boolean }
  | { type: 'factory'; operation: 'orchestrate' | 'prd'; projectId?: string; prdId?: string; request?: string; runtime?: 'claude-code' | 'omnimancer'; provider?: string; model?: string; createPr?: boolean }

export interface AgentConfig {
  agent: AgentId
  prompt: string
  repo?: { url: string; baseBranch: string }
  output?: 'pr' | 'branch' | 'none'
  check?: { command: string }
  model?: string
  environmentId?: string
  /** Routini's own MCP tools for the agent. */
  routini?: boolean
}

export interface ApprovalConfig {
  message: string
  minRole?: 'member' | 'admin' | 'owner'
}

interface StepBase {
  id: string
  name: string
  when: When
  timeoutSec?: number
  retries: number
}
export type Step =
  | (StepBase & { kind: 'action'; config: ActionConfig })
  | (StepBase & { kind: 'agent'; config: AgentConfig })
  | (StepBase & { kind: 'approval'; config: ApprovalConfig })

export interface Job {
  id: string
  name: string
  description: string
  trigger: Trigger
  steps: Step[]
  enabled: boolean
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
  webhookUrl?: string
  lastRun?: { id: string; number: number; status: RunStatus; createdAt: string; finishedAt: string | null } | null
}

export interface RunSummary {
  id: string
  number: number
  jobId: string
  jobName: string
  status: RunStatus
  trigger: string
  costUsd: number
  agentSeconds: number
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RunStep {
  idx: number
  stepId: string
  name: string
  kind: StepKind
  status: StepStatus
  attempt: number
  output: Record<string, unknown> | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface Approval {
  id: string
  runId: string
  stepIdx: number
  status: 'pending' | 'approved' | 'denied' | 'canceled'
  message: string
  minRole: Role
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  comment: string | null
  /** "policy": raised by a policy rule in front of another step. */
  source?: 'step' | 'policy'
  rule?: string | null
}

export interface RunDetail {
  run: RunSummary & { jobSnapshot: { name: string; steps: Step[] }; trigger: { kind: string; [k: string]: unknown }; cancelRequested: boolean }
  steps: RunStep[]
  approvals: Approval[]
}

export interface RunEvent {
  id: number
  runId: string
  stepIdx: number | null
  ts: string
  type: string
  data: Record<string, unknown>
}

export interface Inbox {
  approvals: Array<Approval & { runNumber: number; jobName: string; stepName: string }>
  failures: RunSummary[]
  live: RunSummary[]
  upcoming: Array<{ jobId: string; name: string; nextRunAt: string }>
  /** Open incidents (Phase 3). */
  incidents?: Incident[]
}

export interface HostCheck {
  ok: boolean
  at: string
  kernel?: string
  uptime?: string
  diskUsedPct?: number
  memUsedPct?: number
  error?: string
}

export interface Host {
  id: string
  name: string
  group: string
  address: string
  port: number
  username: string | null
  auth: 'key' | 'password'
  credentialKey: string | null
  tags: string[]
  lastCheck: HostCheck | null
  transport: 'ssh' | 'runner'
  runner: HostRunner | null
}

export interface HostRunner {
  id: string
  name: string
  version: string | null
  hostname: string | null
  online: boolean
  connectedAt: string | null
  lastSeenAt: string | null
  capabilities: string[]
  facts: Record<string, unknown> | null
  revoked: boolean
}

export interface HostEvent {
  id: number
  ts: string
  type: string
  userId: string | null
  data: Record<string, unknown>
}

export interface Integration {
  id: string
  name: string
  description: string
  setupUrl: string
  setupLabel: string
  fields: Array<{ key: string; label: string; secret: boolean }>
  status: 'not_connected' | 'connected' | 'error'
  connectedAt: string | null
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestMessage: string | null
  scopes: { agents: AgentId[] }
  /** Used by Routini itself (e.g. Factory steps), never handed to agents. */
  serverOnly?: boolean
}

export type AIEndpoint = 'anthropic' | 'openrouter' | 'digitalocean' | 'aws-bedrock' | 'openai' | 'google' | 'azure' | 'gateway'

export interface OrgSettings {
  ai: { defaultAgent: AgentId; agents: Record<AgentId, { endpoint: AIEndpoint; model: string; gatewayUrl?: string }> }
  notifications: { enabled: boolean; recipientEmail: string; notifyOnSuccess: boolean; notifyOnFailure: boolean }
  endpointKeys: Record<string, boolean>
}

export interface Member extends User {
  role: Role
}

export interface CredentialMeta {
  key: string
  createdAt: string
  updatedAt: string
}

export type EnvStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'deleting'

export interface Environment {
  id: string
  name: string
  image: string
  repo: { url: string; branch: string; dir: string } | null
  status: EnvStatus
  statusDetail: string | null
  cpus: number
  memoryMb: number
  idleMinutes: number
  lastActiveAt: string
  createdAt: string
  /** Self-host only, while running: attach with your own tools. */
  attachCommand?: string
}

export interface EnvEvent {
  id: number
  ts: string
  type: string
  userId: string | null
  data: Record<string, unknown>
}

// ── Policy, egress and MCP (Phase 2) ─────────────────────────────────────────

export type PolicyEffect = 'allow' | 'require_approval' | 'deny'

export interface PolicyMatch {
  kinds?: Array<'action' | 'agent'>
  actionTypes?: Array<'http' | 'ssh' | 'imap' | 'factory'>
  hostTags?: string[]
  hostGroups?: string[]
  agentOutputs?: Array<'pr' | 'branch' | 'none'>
  inEnvironment?: boolean
  repoHosts?: string[]
}

export interface PolicyRule {
  id: string
  name: string
  match: PolicyMatch
  effect: PolicyEffect
  minRole?: 'member' | 'admin' | 'owner'
  reason?: string
}

export interface OrgPolicy {
  rules: PolicyRule[]
  egress: { allowedHosts: string[] }
  updatedAt: string | null
  isDefault: boolean
}

export interface PolicyDecision {
  stepId: string
  effect: PolicyEffect
  rule: { id: string; name: string; minRole?: string; reason?: string } | null
}

export interface McpServer {
  id: string
  name: string
  url: string
  headerNames: string[]
  agents: AgentId[]
  lastTest: { ok: boolean; at: string; message: string } | null
  createdAt: string
}

// ── Fleet and incidents (Phase 3) ────────────────────────────────────────────

export interface Enrollment {
  token: string
  expiresAt: string
  url: string
  commands: { script: string; docker: string; manual: string }
}

export interface Postmortem {
  markdown: string
  generatedAt: string | null
  editedAt: string | null
  editedBy: string | null
}

export interface Incident {
  id: string
  number: number
  fingerprint: string
  title: string
  severity: string
  status: 'open' | 'resolved'
  source: string
  labels: Record<string, string>
  annotations: Record<string, string>
  hostId: string | null
  hostName: string | null
  alertCount: number
  openedAt: string
  lastAlertAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  postmortem: Postmortem | null
}

export interface IncidentEvent {
  id: number
  ts: string
  type: string
  userId: string | null
  userName: string | null
  data: Record<string, unknown>
}

export interface IncidentRun {
  id: string
  number: number
  jobName: string
  status: RunStatus
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface IncidentDetail {
  incident: Incident
  events: IncidentEvent[]
  runs: IncidentRun[]
}

// ── API tokens and sign-in (Phase 4) ─────────────────────────────────────────

export interface ApiToken {
  id: string
  name: string
  role: 'viewer' | 'member' | 'admin'
  userEmail?: string
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface CreatedToken {
  token: string
  apiToken: ApiToken
  mcpUrl: string
  mcpCommand: string
}
