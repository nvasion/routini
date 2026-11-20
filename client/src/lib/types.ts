// API shapes, mirroring the server's responses (server/src/routes/*).

export type Role = 'owner' | 'admin' | 'member' | 'viewer'
export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled'
export type StepStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'canceled'
export type StepKind = 'action' | 'agent' | 'approval'
export type AgentId = 'claude' | 'omnimancer'

export interface User {
  id: string
  email: string
  displayName: string
  /** Absent from servers older than Phase 5. */
  emailVerified?: boolean
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
/** A cron job that picks ready backlog items instead of (or as well as) running on the clock alone. */
export interface CronBacklog {
  sourceIds?: string[]
  labels?: string[]
  maxPerFire: number
}
export type Trigger =
  | { kind: 'manual' }
  | { kind: 'cron'; expr: string; tz: string; backlog?: CronBacklog }
  | { kind: 'webhook' }
  | { kind: 'alert'; match: AlertMatch }
export type When = 'on_success' | 'on_failure' | 'always'

// ── Backlog (work intake, Phase 3) ───────────────────────────────────────────

/** One item's lifecycle. Nothing automatic moves an item out of `blocked`; only a person does. */
export type ItemState = 'ready' | 'planning' | 'building' | 'finishing' | 'done' | 'blocked' | 'dropped'
export const ITEM_STATES: ItemState[] = ['ready', 'planning', 'building', 'finishing', 'done', 'blocked', 'dropped']

/** How Routini states map onto a source's own status values, and which of the source's values mean "ready" or "dropped". */
export interface StatusMapping {
  out: Partial<Record<ItemState, { value: string; comment?: boolean }>>
  in: { ready: string[]; dropped: string[] }
}

/** One item as read from a source adapter, before Routini has a row for it. */
export interface SourceItem {
  externalId: string
  title: string
  body: string
  url?: string | null
  repoUrl?: string | null
  baseBranch?: string | null
  labels?: string[]
  externalState: string
  position?: number | null
}

export interface BacklogSource {
  id: string
  orgId: string
  name: string
  kind: 'monday' | 'repo'
  config: Record<string, unknown>
  mapping: StatusMapping
  defaultRepoUrl: string | null
  defaultBaseBranch: string
  factoryProjectId: string | null
  enabled: boolean
  syncEveryMin: number
  nextSyncAt: string
  lastSyncAt: string | null
  lastSyncError: string | null
  createdAt: string
  updatedAt: string
}

export type SourceInput = {
  name: string
  kind: 'monday' | 'repo'
  config: Record<string, unknown>
  mapping: StatusMapping
  defaultRepoUrl?: string | null
  defaultBaseBranch?: string
  factoryProjectId?: string | null
  enabled?: boolean
  syncEveryMin?: number
}

export interface BacklogItem {
  id: string
  orgId: string
  sourceId: string
  externalId: string
  title: string
  body: string
  url: string | null
  repoUrl: string | null
  baseBranch: string | null
  labels: string[]
  externalState: string
  state: ItemState
  stateNote: string | null
  position: number | null
  runId: string | null
  lastRunId: string | null
  builtBy: string | null
  pullRequestUrl: string | null
  dropAfterRun: boolean
  createdAt: string
  updatedAt: string
}

export interface BacklogItemEvent {
  id: string
  at: string
  kind: string
  data: Record<string, unknown>
}

/** A failed status write, as listed on a source and on the inbox. */
export interface BacklogWrite {
  id: string
  itemId: string
  itemTitle: string
  sourceName: string
  state: ItemState
  note?: string | null
  attempts: number
  lastError: string | null
  failedAt: string | null
}

export type ActionConfig =
  | { type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string; expectStatus?: number; timeoutMs?: number }
  /** A command on a host (SSH or routini-runner). host: 'alert' targets the incident's host. */
  | { type: 'ssh'; hostId?: string; host?: 'alert'; command: string }
  | { type: 'imap'; host: string; port?: number; username: string; credentialKey: string; mailbox?: string; search?: string; tls?: boolean }
  | {
      type: 'factory'
      operation: 'orchestrate' | 'prd' | 'task' | 'from-step'
      /** from-step only: a template path (no {{ }}) like steps.plan.out.builder, naming an earlier step. */
      operationFrom?: string
      projectId?: string
      prdId?: string
      request?: string
      /** The Factory project's origin must match this repo, or the step fails before dispatch. */
      repoUrl?: string
      /** task only, 0-5. */
      maxRetries?: number
      runtime?: 'claude-code' | 'omnimancer'
      provider?: string
      model?: string
      createPr?: boolean
    }
  | { type: 'azure-boards'; project: string; query?: string; limit?: number }
  | { type: 'teams'; message: string; title?: string }

/** Every member of the ActionConfig union's `type` field. */
export type ActionType = ActionConfig['type']

/** A choice available to a `choice` return field; `requires` names an integration id the choice needs (e.g. 'factory'). */
export interface AgentReturnChoice {
  value: string
  requires?: string
}

/** A typed field an agent returns; later steps read it as {{steps.<id>.out.<name>}}. */
export interface AgentReturnField {
  name: string
  type: 'text' | 'number' | 'boolean' | 'choice'
  choices?: AgentReturnChoice[]
  /** Defaults to true. */
  required?: boolean
  description?: string
}

export interface AgentConfig {
  agent: AgentId
  prompt: string
  repo?:
    | { url: string; baseBranch: string; /** A shallow, read-only checkout: the agent can't push, so output defaults to 'none'. */ readOnly?: boolean }
    /** The repository of the backlog item this run was started from (only valid on a backlog run). */
    | { fromItem: true; readOnly?: boolean }
  output?: 'pr' | 'branch' | 'none'
  check?: { command: string }
  model?: string
  environmentId?: string
  /** Run on a fleet host (routini-runner) instead of the Routini sandbox; `pool` picks one at run time. */
  runOn?: { hostId: string } | { host: 'alert' } | { pool: { group?: string; tags?: string[] } }
  /** Routini's own MCP tools for the agent. */
  routini?: boolean
  /** Typed fields this step writes, for later steps to read. */
  returns?: AgentReturnField[]
  /** Pull an earlier Factory step's result into this step's clone instead of starting clean; `step` names that earlier action step (type factory). */
  startFrom?: { step: string }
}

export interface ApprovalConfig {
  message: string
  minRole?: 'member' | 'admin' | 'owner'
}

/** A step condition: run only if the templated value at `path` compares as given. `path` has no {{ }}; its root must be `steps` or `trigger`. */
export interface StepCondition {
  path: string
  op: 'eq' | 'ne' | 'in' | 'not_in' | 'exists' | 'missing'
  value?: string | string[]
}

interface StepBase {
  id: string
  name: string
  when: When
  timeoutSec?: number
  retries: number
  if?: StepCondition
  /** On a backlog run, moves the item to this state when the step starts running. */
  stage?: 'planning' | 'building' | 'finishing'
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
  /** Status writes to a backlog source that have failed at least once (Phase 3). */
  backlogWrites?: BacklogWrite[]
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

/**
 * What the runner reports about its machine (osPretty, load1, cpus, addresses…).
 * `docker` is the Docker version it found, absent when Docker is not installed.
 */
/** Runner facts (routini-runner PROTOCOL.md 2.2); anything may be missing. */
export type RunnerFacts = Record<string, unknown> & {
  /** Present only when the runner's Docker daemon answered. */
  docker?: { available: boolean; version: string; agentsRunning: number; maxAgents: number }
  /** Why agents do or do not run (runner ≥ 0.3.0). */
  agents?: { configured: boolean; error?: string }
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
  facts: RunnerFacts | null
  revoked: boolean
}

/** GET /runners/latest */
export interface RunnerLatest {
  version: string | null
  commands: { reinstall: string; enableAgents: string }
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
  /** Listed but not connectable yet. */
  comingSoon?: boolean
}

export type AIEndpoint = 'anthropic' | 'openrouter' | 'digitalocean' | 'aws-bedrock' | 'openai' | 'google' | 'azure' | 'gateway'

export interface OrgSettings {
  ai: { defaultAgent: AgentId; agents: Record<AgentId, { endpoint: AIEndpoint; model: string; gatewayUrl?: string; region?: string }> }
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
  /** The fleet host (routini-runner) this environment's container runs on; null runs on Routini's own Docker host. */
  hostId: string | null
  host: { id: string; name: string } | null
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
  actionTypes?: ActionType[]
  hostTags?: string[]
  hostGroups?: string[]
  agentOutputs?: Array<'pr' | 'branch' | 'none'>
  agentPlacements?: Array<'sandbox' | 'fleet'>
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
