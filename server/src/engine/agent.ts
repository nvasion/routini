// ─────────────────────────────────────────────────────────────────────────────
// Agent step executor: runs a coding agent in an ephemeral container.
//
// Contract with the image (see agents/README.md):
//   env in   ROUTINI_PROMPT, ROUTINI_SYSTEM_PROMPT, ROUTINI_MODEL, REPO_URL, BASE_BRANCH,
//            WORK_BRANCH, CHECK_COMMAND, ROUTINI_OUTPUT (pr|branch|none),
//            model endpoint vars, in-scope integration vars (e.g. GITHUB_TOKEN)
//   stdout   Claude Code stream-json, plus ::routini::{json} control lines
//            (check, commit, pushed, no_changes, error)
//   exit     0 success · 3 check failed · anything else failure
// The worker — not the container — opens the pull request.
//
// Three places an agent can run, all sharing the stream parser and everything
// after the container exits (facts, cost, pull request):
//   sandbox      a fresh container on Routini's Docker host (the default)
//   environment  a persistent container on that same host
//   fleet        config.runOn: a container the org's own routini-runner starts
//                on one of its hosts, behind that host's egress proxy
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes, randomUUID } from 'node:crypto'
import { DockerService } from '../services/docker.js'
import type { Queryable } from '../db/index.js'
import { getOrgSettings, getEndpointKey, type AgentEndpointConfig } from '../repos/settings.js'
import { getBrokeredIntegrationAccess, getIntegrationCredentials, getScopedIntegrationEnv } from '../repos/integrations.js'
import { mcpAccessFor, type ExtraMcpServer } from '../repos/mcp.js'
import { createApiToken, revokeApiToken, runActor } from '../repos/apiTokens.js'
import { getPolicy } from '../repos/policy.js'
import { getHost, type Host } from '../repos/hosts.js'
import { PLACEHOLDER, type CredentialBinding, type EgressSession } from '../egress/types.js'
import { sandboxNetworkName, sandboxNetworkPrefix } from '../egress/client.js'
import { usageToday } from '../repos/runs.js'
import { createPullRequest, parseGithubRepo } from '../integrations/github.js'
import type { FetchFn } from '../integrations/providers.js'
import type { AgentId } from '../integrations/catalog.js'
import { AgentStreamParser } from './agentStream.js'
import { EnvError, type EnvPlacement } from './environments.js'
import { addEnvironmentEvent, getEnvironment, type Environment } from '../repos/environments.js'
import type { AgentConfig } from './spec.js'
import type { StepContext, StepExecutor, StepResult } from './types.js'
import { emitPlacement } from './placement.js'
import { dockerHostLabel, sandboxHostConfig } from '../services/dockerClient.js'
import { orgHasVerifiedOwner } from '../repos/identity.js'
import { runAgentOnRunner, type RunnerAgentOutcome } from '../runner/agent.js'
import { NO_AGENTS_ERROR } from '../runner/gateway.js'
import { fleetAgentImages, fleetEgressImage } from './fleetImages.js'

export const DEFAULT_AGENT_TIMEOUT_SEC = 30 * 60
const DEFAULT_CPUS = 2
const DEFAULT_MEMORY_MB = 4096
/** uid:gid of the non-root `agent` user baked into Routini's agent images. */
const AGENT_USER = '1000:1000'
/** How long the run-scoped token and the egress session outlive the step's own timeout. */
const GRACE_SEC = 600

export const SYSTEM_PROMPT = [
  'You are running unattended inside Routini, an automation platform. No human is watching this session.',
  'Do not ask questions; make reasonable assumptions and state them in your final message.',
  'Work only inside the current directory. Do not commit or push: Routini commits, pushes and opens the pull request after you finish.',
  'End with a short summary of what you changed and why.',
].join(' ')

export type AgentDocker = Pick<DockerService, 'runStreaming' | 'killByLabels'>

export interface AgentRunnerOptions {
  docker?: AgentDocker
  /** Image per agent. Defaults from ROUTINI_AGENT_IMAGE_<AGENT>, else routini/agent-claude:latest for claude. */
  images?: Partial<Record<AgentId, string>>
  /** Image per agent on a fleet host. Defaults from ROUTINI_FLEET_AGENT_IMAGE_<AGENT>. */
  fleetImages?: Partial<Record<AgentId, string>>
  /** Egress proxy image a fleet host runs beside the agent. Default: ROUTINI_FLEET_EGRESS_IMAGE. */
  fleetEgressImage?: string
  /** Fleet agents: how long to wait for an offline runner, and the result poll interval. */
  runnerOfflineGraceMs?: number
  runnerPollMs?: number
  /** fetch for the GitHub API (tests). */
  fetchImpl?: FetchFn
}

export function defaultAgentImages(env: NodeJS.ProcessEnv = process.env): Partial<Record<AgentId, string>> {
  return {
    claude: env['ROUTINI_AGENT_IMAGE_CLAUDE'] || 'routini/agent-claude:latest',
    omnimancer: env['ROUTINI_AGENT_IMAGE_OMNIMANCER'] || undefined,
    opencode: env['ROUTINI_AGENT_IMAGE_OPENCODE'] || undefined,
  }
}

// Fleet images live in fleetImages.ts (environments.ts needs them too, and
// importing agent.ts from there would be a cycle); re-exported for callers.
export { fleetAgentImages, fleetEgressImage, fleetEnvImages } from './fleetImages.js'

class StepFailure extends Error {}

/** Model endpoint env for Claude Code. Throws StepFailure for endpoints it can't reach directly. */
function claudeEndpointEnv(cfg: AgentEndpointConfig, key: string | null): Record<string, string> {
  switch (cfg.endpoint) {
    case 'anthropic':
      if (!key) throw new StepFailure('No Anthropic API key is stored. Add one in Settings → Models.')
      return { ANTHROPIC_API_KEY: key }
    case 'openrouter':
      if (!key) throw new StepFailure('No OpenRouter API key is stored. Add one in Settings → Models.')
      // OpenRouter serves the Anthropic Messages API under /api.
      return { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' }
    case 'gateway':
      return { ANTHROPIC_BASE_URL: cfg.gatewayUrl ?? '', ANTHROPIC_AUTH_TOKEN: key ?? 'routini-gateway' }
    case 'aws-bedrock':
      if (!key) throw new StepFailure('No AWS Bedrock API key is stored. Add one in Settings → Models.')
      return bedrockEnv(cfg, key)
    default:
      throw new StepFailure(`Claude Code reaches "${cfg.endpoint}" through claude-code-model-gateway. Set the Claude endpoint to "gateway" in Settings → Models.`)
  }
}

/**
 * Claude Code on Bedrock: native support, authenticated with a Bedrock API key
 * (sent as `authorization: Bearer`, no SigV4). Claude Code needs the region
 * explicitly; it does not read ~/.aws/config.
 */
function bedrockEnv(cfg: AgentEndpointConfig, token: string): Record<string, string> {
  if (!cfg.region) throw new StepFailure('The AWS Bedrock endpoint needs a region. Set one in Settings → Models.')
  return { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: cfg.region, AWS_BEARER_TOKEN_BEDROCK: token, ANTHROPIC_API_KEY: '' }
}

/** Runtime (inference) and control-plane (inference profiles, credential checks) hosts agents call on Bedrock. */
const bedrockHosts = (region: string) => [`bedrock-runtime.${region}.amazonaws.com`, `bedrock.${region}.amazonaws.com`]

/** Model endpoint env for agents other than Claude Code; their image maps ROUTINI_ENDPOINT* onto its own config. */
function routiniEndpointEnv(cfg: AgentEndpointConfig, key: string): Record<string, string> {
  const env: Record<string, string> = { ROUTINI_ENDPOINT: cfg.endpoint, ROUTINI_ENDPOINT_KEY: key }
  if (cfg.endpoint === 'gateway' && cfg.gatewayUrl) env['ROUTINI_GATEWAY_URL'] = cfg.gatewayUrl
  if (cfg.endpoint === 'aws-bedrock') {
    if (!cfg.region) throw new StepFailure('The AWS Bedrock endpoint needs a region. Set one in Settings → Models.')
    env['ROUTINI_ENDPOINT_REGION'] = cfg.region
  }
  return env
}

/** When a brokered credential stops working: the step's own timeout plus a grace period. */
const egressExpiry = (timeoutSec: number) => new Date(Date.now() + (timeoutSec + GRACE_SEC) * 1000).toISOString()

/** Logs and emits what an egress proxy refused, wherever the agent ran. */
async function reportBlockedEgress(ctx: StepContext, blocked: string[] | undefined): Promise<void> {
  if (!blocked?.length) return
  await ctx.log(`Blocked outbound connections (not on the org's allow-list): ${blocked.join(', ')}`)
  await ctx.emit('egress.blocked', { hosts: blocked })
}

/**
 * The fleet host a `runOn` step names, with the runner that starts the
 * container on it. Every failure names the host and what to do about it.
 */
async function fleetTarget(ctx: StepContext, hostId: string): Promise<{ host: Host; runnerId: string }> {
  const orgId = ctx.org.id
  const host = await ctx.app.db.org(orgId, (q) => getHost(q, orgId, hostId))
  if (!host) throw new StepFailure(`The host this agent step runs on (${hostId}) has left the fleet; point the step at another host`)
  if (host.transport !== 'runner') {
    throw new StepFailure(`Host "${host.name}" is reached over SSH; agents need it connected with routini-runner`)
  }
  if (!host.runner || host.runner.revoked) {
    throw new StepFailure(`Host "${host.name}" has no active runner; install routini-runner on it (Fleet → Add server)`)
  }
  if (!host.runner.capabilities.includes('agents')) throw new StepFailure(`Host "${host.name}": ${NO_AGENTS_ERROR}`)
  return { host, runnerId: host.runner.id }
}

/**
 * A runner outcome in the shape the code after the run reads. A non-zero exit
 * is left to it (it knows about failed checks and what the agent printed);
 * anything else the runner reported — offline, disconnected, timed out — is
 * already a sentence for the user.
 */
function fleetResult(outcome: RunnerAgentOutcome, aborted: boolean): { error?: string; exitCode: number | null; timedOut: boolean; aborted: boolean } {
  const unexplained = !outcome.ok && outcome.exitCode === null && !aborted
  return { exitCode: outcome.exitCode, timedOut: false, aborted, ...(unexplained ? { error: outcome.error } : {}) }
}

interface AgentAccess {
  env: Record<string, string>
  bindings: CredentialBinding[]
  hosts: string[]
  secrets: string[]
}

/**
 * What the agent may reach: its model endpoint, in-scope integrations and MCP
 * servers. Brokered means the container sees placeholders while an egress proxy
 * holds the real values and binds them per host; direct puts them in the env.
 * A parameter, not a look at ctx.app.broker: fleet steps are always brokered,
 * by the proxy their own host runs.
 */
async function agentAccess(
  q: Queryable,
  ctx: StepContext,
  cfg: AgentConfig,
  o: { brokered: boolean; routiniMcp: ExtraMcpServer[]; repoUrl?: string },
): Promise<AgentAccess> {
  const orgId = ctx.org.id
  const box = ctx.app.box
  const settings = await getOrgSettings(q, orgId)
  const endpointCfg = settings.ai.agents[cfg.agent]
  const key = endpointCfg.endpoint === 'gateway' ? await getEndpointKey(q, box, orgId, 'anthropic') : await getEndpointKey(q, box, orgId, endpointCfg.endpoint)
  const model = cfg.model ?? endpointCfg.model
  const mcp = await mcpAccessFor(q, box, orgId, cfg.agent, o.brokered, o.routiniMcp)
  const common = { ...(model ? { ROUTINI_MODEL: model } : {}), ...(mcp.config ? { ROUTINI_MCP_CONFIG: JSON.stringify(mcp.config) } : {}) }
  if (!o.brokered) {
    const integrationEnv = await getScopedIntegrationEnv(q, box, orgId, cfg.agent)
    const modelEnv = cfg.agent === 'claude' ? claudeEndpointEnv(endpointCfg, key) : routiniEndpointEnv(endpointCfg, key ?? '')
    const env: Record<string, string> = { ...integrationEnv, ...modelEnv, ...common }
    return { env, bindings: [], hosts: [], secrets: [...Object.values(integrationEnv), ...Object.values(modelEnv), ...mcp.secrets] }
  }
  const integ = await getBrokeredIntegrationAccess(q, box, orgId, cfg.agent)
  const modelAccess = brokeredModelAccess(cfg.agent, endpointCfg, key)
  const policy = await getPolicy(q, orgId, ctx.app.config.mode)
  const hosts = new Set([...policy.egress.allowedHosts, ...integ.hosts, ...modelAccess.hosts, ...mcp.hosts])
  if (o.repoUrl) hosts.add(new URL(o.repoUrl).hostname)
  return {
    env: { ...integ.env, ...modelAccess.env, ...common } as Record<string, string>,
    bindings: [...integ.bindings, ...modelAccess.bindings, ...mcp.bindings],
    hosts: [...hosts],
    secrets: [...integ.secrets, ...modelAccess.secrets, ...mcp.secrets],
  }
}

export function agentExecutor(opts: AgentRunnerOptions = {}): StepExecutor {
  const docker = opts.docker ?? new DockerService()
  const images = { ...defaultAgentImages(), ...opts.images }
  const fleetImages = { ...fleetAgentImages(), ...opts.fleetImages }
  const egressImage = opts.fleetEgressImage ?? fleetEgressImage()

  return {
    async execute(ctx: StepContext): Promise<StepResult> {
      const cfg = ctx.step.config as AgentConfig
      const { db, box } = ctx.app
      const orgId = ctx.org.id
      try {
        // ── Limits ───────────────────────────────────────────────────────
        if (ctx.app.config.requireVerifiedEmail && !(await orgHasVerifiedOwner(db, orgId))) {
          throw new StepFailure('email_unverified — verify your email address (Settings → Account) before running agent steps')
        }
        // After prepare, runOn is always { hostId }: one of the org's own hosts runs this step.
        const runOnHostId = cfg.runOn && 'hostId' in cfg.runOn ? cfg.runOn.hostId : null
        // A quick row read, before the limit checks: an environment pinned to a fleet host
        // (env.hostId) is fleet compute too, same as runOn, even though it is reached below.
        const envRow = cfg.environmentId ? await db.org(orgId, (q) => getEnvironment(q, orgId, cfg.environmentId!)) : null
        const fleetCompute = !!runOnHostId || !!envRow?.hostId
        const usage = await db.org(orgId, (q) => usageToday(q, orgId))
        const { agentMinutesPerDay, dailyBudgetUsd } = ctx.org.limits
        // Fleet agents spend the org's own server time, so the agent-minute budget does not apply.
        if (!fleetCompute && agentMinutesPerDay !== null && usage.agentSeconds >= agentMinutesPerDay * 60) {
          throw new StepFailure(`limit_exceeded:agent_minutes — this org used its ${agentMinutesPerDay} agent minutes for today (UTC)`)
        }
        if (dailyBudgetUsd !== null && usage.costUsd >= dailyBudgetUsd) {
          throw new StepFailure(`limit_exceeded:daily_budget — this org reached its $${dailyBudgetUsd} model budget for today (UTC)`)
        }
        let timeoutSec = ctx.step.timeoutSec ?? DEFAULT_AGENT_TIMEOUT_SEC
        if (!fleetCompute && agentMinutesPerDay !== null) timeoutSec = Math.min(timeoutSec, agentMinutesPerDay * 60 - usage.agentSeconds)

        // ── Where it runs: a fleet host, a persistent environment, or a fresh container ─
        const fleet = runOnHostId ? await fleetTarget(ctx, runOnHostId) : null
        let environment: Environment | null = null
        let envPlacement: EnvPlacement | null = null
        // `runOn` and `environmentId` are mutually exclusive (see spec.ts), so a
        // fleet step never has one — and must not wake a container it won't use.
        if (cfg.environmentId && !fleet) {
          try {
            environment = await ctx.app.envs.ensureRunning(orgId, cfg.environmentId)
            // Where the environment's own container lives: Routini's Docker host, or (env.hostId) a fleet host.
            envPlacement = await ctx.app.envs.placement(environment)
          } catch (err) {
            if (err instanceof EnvError) throw new StepFailure(err.message)
            throw err
          }
        }
        const image = fleet ? fleetImages[cfg.agent] : environment ? environment.image : images[cfg.agent]
        if (!image) {
          throw new StepFailure(
            fleet
              ? `No fleet image is configured for the ${cfg.agent} agent; set ROUTINI_FLEET_AGENT_IMAGE_${cfg.agent.toUpperCase()} on this server`
              : `No runner image is configured for the ${cfg.agent} agent on this server`,
          )
        }
        const repo = cfg.repo ?? (environment?.repo ? { url: environment.repo.url, baseBranch: environment.repo.branch } : undefined)

        // ── Credentials: brokered (placeholders + proxy bindings) or direct env ─
        // A fleet step is always brokered, by the egress proxy the runner starts on its
        // host; so is a step in a fleet environment, by that same host's proxy. Neither
        // has anything to do with this server's own broker (ctx.app.broker).
        const broker = fleet ? null : envPlacement ? envPlacement.broker : ctx.app.broker
        const brokered = fleet !== null || broker !== null
        if (!fleet && !broker && ctx.app.config.mode === 'hosted') {
          throw new StepFailure('Agent steps on this server require the credential broker, which is not configured; ask the operator')
        }
        // Routini's own tools: a run-scoped token, revoked when the step ends (expires anyway).
        let routiniToken: { id: string; token: string } | null = null
        if (cfg.routini) {
          routiniToken = await db.org(orgId, async (q) => {
            const actor = await runActor(q, orgId, ctx.run as { jobId: string; trigger: { kind: string; userId?: string } })
            if (!actor) throw new StepFailure('Routini tools need an org member to act as; the job author is no longer a member')
            const { token, apiToken } = await createApiToken(q, orgId, actor, {
              name: `run #${ctx.run.number} step ${ctx.idx + 1}`,
              role: 'member',
              runId: ctx.run.id,
              expiresAt: new Date(Date.now() + (timeoutSec + GRACE_SEC) * 1000),
            })
            return { id: apiToken.id, token }
          })
          ctx.addSecret(routiniToken.token)
        }
        const routiniMcp = routiniToken ? [{ name: 'routini', url: `${ctx.app.config.agentApiUrl}/mcp`, headers: { authorization: `Bearer ${routiniToken.token}` }, direct: ctx.app.config.agentApiUrl.startsWith('http:') }] : []
        const revokeRoutiniToken = async () => {
          if (routiniToken) await db.org(orgId, (q) => revokeApiToken(q, orgId, routiniToken!.id)).catch(() => {})
        }

        const access = await db.org(orgId, (q) => agentAccess(q, ctx, cfg, { brokered, routiniMcp, repoUrl: repo?.url }))
        for (const s of access.secrets) ctx.addSecret(s)
        const env = access.env

        const output = repo ? (cfg.output ?? 'pr') : 'none'
        const workBranch = `routini/run-${ctx.run.number}${ctx.run.jobSnapshot.steps.filter((s) => s.kind === 'agent').length > 1 ? `-${ctx.step.id}` : ''}`
        Object.assign(env, {
          ROUTINI_PROMPT: cfg.prompt,
          ROUTINI_SYSTEM_PROMPT: SYSTEM_PROMPT,
          ROUTINI_OUTPUT: output,
          ROUTINI_COMMIT_MESSAGE: `${ctx.run.jobSnapshot.name} (Routini run #${ctx.run.number})`,
          ...(repo ? { REPO_URL: repo.url, BASE_BRANCH: repo.baseBranch, WORK_BRANCH: workBranch } : {}),
          ...(environment?.repo ? { ROUTINI_REPO_DIR: `/workspace/${environment.repo.dir}` } : {}),
          ...(cfg.check ? { CHECK_COMMAND: cfg.check.command } : {}),
        })

        // ── Run ─────────────────────────────────────────────────────────
        const parser = new AgentStreamParser()
        let emitting = Promise.resolve()
        const started = Date.now()
        const onLine = (line: string, stream: 'stdout' | 'stderr') => {
          for (const ev of parser.line(line, stream)) {
            emitting = emitting.then(() => ctx.emit(ev.type, ev.data))
          }
        }
        // Broker session: the container's only way out, holding the real credentials.
        let session: { token: string } | null = null
        let network: string | undefined
        if (broker) {
          const token = broker.newToken()
          try {
            network = await broker.network(orgId)
            await broker.open({
              token,
              orgId,
              label: `run ${ctx.run.number} step ${ctx.idx + 1}`,
              allowedHosts: access.hosts,
              bindings: access.bindings,
              expiresAt: egressExpiry(timeoutSec),
            })
          } catch (err) {
            throw new StepFailure(`The credential broker is unavailable: ${(err as Error).message}`)
          }
          session = { token }
          Object.assign(env, await broker.containerEnv(token))
          await ctx.log(`Network: sandboxed; ${access.bindings.length} credential${access.bindings.length === 1 ? '' : 's'} brokered, ${access.hosts.length} hosts allowed`)
        }
        const closeSession = async () => {
          if (!broker || !session) return
          const stats = await broker.close(session.token)
          session = null
          await reportBlockedEgress(ctx, stats?.blocked)
        }

        const labels = { 'routini.managed': 'true', 'routini.org': orgId, 'routini.run': ctx.run.id, 'routini.step': String(ctx.idx) }
        let result: { error?: string; exitCode: number | null; timedOut: boolean; aborted: boolean }
        /** A fleet host's proxy reports its counters with the agent's exit, not on close. */
        let fleetEgress: RunnerAgentOutcome['egress'] = null
        try {
          if (fleet) {
            await emitPlacement(ctx, { target: 'fleet', via: 'runner', host: fleet.host.name, hostId: fleet.host.id })
            await ctx.log(`Starting ${cfg.agent} agent (${image}) on ${fleet.host.name} via routini-runner`)
            // The real credentials travel sealed, in the session the host's own egress proxy holds.
            const egressSession: EgressSession = {
              token: randomBytes(24).toString('hex'),
              orgId,
              label: `run ${ctx.run.number} step ${ctx.idx + 1}`,
              allowedHosts: access.hosts,
              bindings: access.bindings,
              expiresAt: egressExpiry(timeoutSec),
            }
            ctx.addSecret(egressSession.token)
            const outcome = await runAgentOnRunner(ctx, {
              runnerId: fleet.runnerId,
              hostName: fleet.host.name,
              payload: {
                type: 'agent',
                image,
                pull: 'missing',
                user: AGENT_USER,
                cpus: cfg.resources?.cpus ?? DEFAULT_CPUS,
                memoryMb: cfg.resources?.memoryMb ?? DEFAULT_MEMORY_MB,
                pidsLimit: sandboxHostConfig().PidsLimit,
                timeoutSec,
                labels,
                egressImage,
                network: sandboxNetworkName(sandboxNetworkPrefix(), orgId),
              },
              secret: { env, session: egressSession },
              onLine,
              offlineGraceMs: opts.runnerOfflineGraceMs,
              pollMs: opts.runnerPollMs,
            })
            fleetEgress = outcome.egress
            result = fleetResult(outcome, ctx.signal.aborted)
          } else if (environment) {
            if (envPlacement!.host) {
              await emitPlacement(ctx, { target: 'fleet', via: 'runner', host: envPlacement!.host.name, hostId: envPlacement!.host.id, environment: environment.name })
              await ctx.log(`Starting ${cfg.agent} agent in environment "${environment.name}" on ${envPlacement!.host.name} via routini-runner`)
            } else {
              await emitPlacement(ctx, { target: 'sandbox', host: dockerHostLabel(), environment: environment.name })
              await ctx.log(`Starting ${cfg.agent} agent in environment "${environment.name}"${repo ? ` (worktree ${workBranch} from ${repo.baseBranch})` : ''}`)
            }
            await ctx.app.envs.touch(orgId, environment.id)
            await ctx.app.db.org(orgId, (q) => addEnvironmentEvent(q, orgId, environment!.id, 'agent.run', null, { runNumber: ctx.run.number, step: ctx.step.name }))
            result = await envPlacement!.runtime.exec(environment.containerId!, ['routini-entrypoint'], { env, timeoutMs: timeoutSec * 1000, signal: ctx.signal, onLine })
            await ctx.app.envs.touch(orgId, environment.id)
            if (result.exitCode === 127) result.error = `The environment's image (${environment.image}) has no routini-entrypoint; use a Routini agent image`
          } else {
            await emitPlacement(ctx, { target: 'sandbox', host: dockerHostLabel() })
            await ctx.log(`Starting ${cfg.agent} agent (${image})${repo ? ` on ${repo.url}@${repo.baseBranch}` : ''}`)
            result = await docker.runStreaming(
              {
                image,
                name: `routini-${ctx.run.number}-${ctx.idx}-${randomUUID().slice(0, 8)}`,
                env,
                user: AGENT_USER,
                cpuCount: cfg.resources?.cpus ?? DEFAULT_CPUS,
                memoryBytes: (cfg.resources?.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024,
                labels,
                network,
              },
              { timeoutMs: timeoutSec * 1000, signal: ctx.signal, onLine },
            )
          }
        } finally {
          await emitting
          await closeSession()
          await reportBlockedEgress(ctx, fleetEgress?.blocked)
          await revokeRoutiniToken()
        }
        const facts = parser.facts
        // Fleet minutes (runOn, or an environment pinned to a host) are the org's own server
        // time, so only the sandbox and Routini-hosted environments add agent seconds.
        await ctx.addUsage({ costUsd: facts.costUsd, ...(fleet || envPlacement?.host ? {} : { agentSeconds: (Date.now() - started) / 1000 }) })

        // ── Outcome ─────────────────────────────────────────────────────
        const base = { costUsd: facts.costUsd, model: facts.model ?? null, turns: facts.turns ?? null, summary: facts.resultText ?? null }
        if (result.error) throw new StepFailure(result.error)
        if (result.aborted) throw new StepFailure('Agent stopped (canceled)')
        if (result.timedOut) throw new StepFailure(`Agent timed out after ${timeoutSec}s`)
        if (result.exitCode !== 0) {
          if (facts.check && facts.check.exitCode !== 0) return { status: 'failed', error: `Check command failed (exit ${facts.check.exitCode})`, output: base }
          const why = facts.errors[0] ?? facts.tail.at(-1) ?? 'no output'
          return { status: 'failed', error: `Agent exited with code ${result.exitCode}: ${why}`, output: base }
        }
        if (facts.resultIsError) return { status: 'failed', error: `The agent reported an error: ${facts.resultText ?? 'unknown'}`, output: base }

        if (facts.noChanges || !facts.pushed) return { status: 'succeeded', output: { ...base, changes: false } }
        const withBranch = { ...base, changes: true, branch: facts.pushed.branch, commit: facts.commit?.sha ?? null }
        if (output === 'branch') {
          await ctx.emit('artifact', { kind: 'branch', branch: facts.pushed.branch, repo: repo!.url })
          return { status: 'succeeded', output: withBranch }
        }

        // output === 'pr'
        const gh = parseGithubRepo(repo!.url)
        if (!gh) return { status: 'failed', error: `Pushed ${facts.pushed.branch}, but pull requests are only supported on github.com`, output: withBranch }
        const token = (await db.org(orgId, (q) => getIntegrationCredentials(q, box, orgId, 'github')))['token']
        if (!token) return { status: 'failed', error: `Pushed ${facts.pushed.branch}, but the GitHub integration is not connected, so no pull request was opened`, output: withBranch }
        ctx.addSecret(token)
        const pr = await createPullRequest(
          token,
          {
            ...gh,
            head: facts.pushed.branch,
            base: repo!.baseBranch,
            title: `${ctx.run.jobSnapshot.name} (Routini run #${ctx.run.number})`,
            body: [
              `Opened by Routini run #${ctx.run.number} of **${ctx.run.jobSnapshot.name}**.`,
              facts.resultText ? `\n### Agent summary\n\n${facts.resultText.slice(0, 6000)}` : '',
              cfg.check ? `\nCheck \`${cfg.check.command}\` passed in the run's environment.` : '',
              `\nModel spend: $${facts.costUsd.toFixed(4)}`,
            ].join('\n'),
          },
          opts.fetchImpl,
        )
        await ctx.emit('artifact', { kind: 'pull_request', url: pr.url, number: pr.number, branch: facts.pushed.branch })
        return { status: 'succeeded', output: { ...withBranch, pullRequest: pr } }
      } catch (err) {
        if (err instanceof StepFailure) return { status: 'failed', error: err.message }
        throw err
      }
    },
  }
}

/** Kills the container a dead worker left behind for (run, step). */
export function killStepContainers(docker: AgentDocker, runId: string, idx: number): Promise<number> {
  return docker.killByLabels({ 'routini.run': runId, 'routini.step': String(idx) })
}

/** Hosts and headers for each model endpoint, when the broker holds the key. */
const ENDPOINT_BINDINGS: Partial<Record<AgentEndpointConfig['endpoint'], { host: string; header: string; format: CredentialBinding['format'] }>> = {
  anthropic: { host: 'api.anthropic.com', header: 'x-api-key', format: 'raw' },
  openrouter: { host: 'openrouter.ai', header: 'authorization', format: 'bearer' },
  openai: { host: 'api.openai.com', header: 'authorization', format: 'bearer' },
  digitalocean: { host: 'inference.do-ai.run', header: 'authorization', format: 'bearer' },
  google: { host: 'generativelanguage.googleapis.com', header: 'x-goog-api-key', format: 'raw' },
}

/**
 * Model access under the broker: the container gets placeholders and the
 * endpoint address; the proxy holds the key and sets it on the endpoint's host.
 */
export function brokeredModelAccess(
  agent: AgentId,
  cfg: AgentEndpointConfig,
  key: string | null,
): { env: Record<string, string>; bindings: CredentialBinding[]; hosts: string[]; secrets: string[] } {
  if (cfg.endpoint === 'gateway') {
    let host: string
    try {
      host = new URL(cfg.gatewayUrl ?? '').hostname
    } catch {
      throw new StepFailure('The model gateway URL is not valid (Settings → Models)')
    }
    const env: Record<string, string> =
      agent === 'claude'
        ? { ANTHROPIC_BASE_URL: cfg.gatewayUrl!, ANTHROPIC_AUTH_TOKEN: key ? PLACEHOLDER : 'routini-gateway' }
        : { ROUTINI_ENDPOINT: 'gateway', ROUTINI_GATEWAY_URL: cfg.gatewayUrl!, ROUTINI_ENDPOINT_KEY: key ? PLACEHOLDER : '' }
    return { env, bindings: key ? [{ host, header: 'authorization', format: 'bearer', secret: key }] : [], hosts: [host], secrets: key ? [key] : [] }
  }
  if (cfg.endpoint === 'aws-bedrock') {
    if (!key) throw new StepFailure('No AWS Bedrock API key is stored. Add one in Settings → Models.')
    const env = agent === 'claude' ? bedrockEnv(cfg, PLACEHOLDER) : routiniEndpointEnv(cfg, PLACEHOLDER)
    const hosts = bedrockHosts(cfg.region!)
    return { env, bindings: hosts.map((host) => ({ host, header: 'authorization', format: 'bearer' as const, secret: key })), hosts, secrets: [key] }
  }
  const b = ENDPOINT_BINDINGS[cfg.endpoint]
  if (!b) throw new StepFailure(`The "${cfg.endpoint}" endpoint is not supported through the credential broker; use the gateway endpoint`)
  if (!key) throw new StepFailure(`No ${cfg.endpoint} API key is stored. Add one in Settings → Models.`)
  if (agent === 'claude' && cfg.endpoint !== 'anthropic' && cfg.endpoint !== 'openrouter') {
    throw new StepFailure(`Claude Code reaches "${cfg.endpoint}" through claude-code-model-gateway. Set the Claude endpoint to "gateway" in Settings → Models.`)
  }
  const binding: CredentialBinding = { ...b, secret: key }
  let env: Record<string, string>
  if (agent === 'claude') {
    env = cfg.endpoint === 'anthropic' ? { ANTHROPIC_API_KEY: PLACEHOLDER } : { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: PLACEHOLDER, ANTHROPIC_API_KEY: '' }
  } else {
    env = { ROUTINI_ENDPOINT: cfg.endpoint, ROUTINI_ENDPOINT_KEY: PLACEHOLDER }
  }
  return { env, bindings: [binding], hosts: [b.host], secrets: [key] }
}
