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
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import { DockerService } from '../services/docker.js'
import { getOrgSettings, getEndpointKey, type AgentEndpointConfig } from '../repos/settings.js'
import { getIntegrationCredentials, getScopedIntegrationEnv } from '../repos/integrations.js'
import { usageToday } from '../repos/runs.js'
import { createPullRequest, parseGithubRepo } from '../integrations/github.js'
import type { FetchFn } from '../integrations/providers.js'
import type { AgentId } from '../integrations/catalog.js'
import { AgentStreamParser } from './agentStream.js'
import type { AgentConfig } from './spec.js'
import type { StepContext, StepExecutor, StepResult } from './types.js'

export const DEFAULT_AGENT_TIMEOUT_SEC = 30 * 60
const DEFAULT_CPUS = 2
const DEFAULT_MEMORY_MB = 4096
/** uid:gid of the non-root `agent` user baked into Routini's agent images. */
const AGENT_USER = '1000:1000'

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
    default:
      throw new StepFailure(`Claude Code reaches "${cfg.endpoint}" through claude-code-model-gateway. Set the Claude endpoint to "gateway" in Settings → Models.`)
  }
}

export function agentExecutor(opts: AgentRunnerOptions = {}): StepExecutor {
  const docker = opts.docker ?? new DockerService()
  const images = { ...defaultAgentImages(), ...opts.images }

  return {
    async execute(ctx: StepContext): Promise<StepResult> {
      const cfg = ctx.step.config as AgentConfig
      const { db, box } = ctx.app
      const orgId = ctx.org.id
      try {
        // ── Limits ───────────────────────────────────────────────────────
        const usage = await db.org(orgId, (q) => usageToday(q, orgId))
        const { agentMinutesPerDay, dailyBudgetUsd } = ctx.org.limits
        if (agentMinutesPerDay !== null && usage.agentSeconds >= agentMinutesPerDay * 60) {
          throw new StepFailure(`limit_exceeded:agent_minutes — this org used its ${agentMinutesPerDay} agent minutes for today (UTC)`)
        }
        if (dailyBudgetUsd !== null && usage.costUsd >= dailyBudgetUsd) {
          throw new StepFailure(`limit_exceeded:daily_budget — this org reached its $${dailyBudgetUsd} model budget for today (UTC)`)
        }
        let timeoutSec = ctx.step.timeoutSec ?? DEFAULT_AGENT_TIMEOUT_SEC
        if (agentMinutesPerDay !== null) timeoutSec = Math.min(timeoutSec, agentMinutesPerDay * 60 - usage.agentSeconds)

        // ── Image, model endpoint, integrations ─────────────────────────
        const image = images[cfg.agent]
        if (!image) throw new StepFailure(`No runner image is configured for the ${cfg.agent} agent on this server`)

        const env = await db.org(orgId, async (q) => {
          const settings = await getOrgSettings(q, orgId)
          const endpointCfg = settings.ai.agents[cfg.agent]
          const key = endpointCfg.endpoint === 'gateway' ? await getEndpointKey(q, box, orgId, 'anthropic') : await getEndpointKey(q, box, orgId, endpointCfg.endpoint)
          const integrationEnv = await getScopedIntegrationEnv(q, box, orgId, cfg.agent)
          const modelEnv =
            cfg.agent === 'claude'
              ? claudeEndpointEnv(endpointCfg, key)
              : { ROUTINI_ENDPOINT: endpointCfg.endpoint, ROUTINI_ENDPOINT_KEY: key ?? '', ...(endpointCfg.gatewayUrl ? { ROUTINI_GATEWAY_URL: endpointCfg.gatewayUrl } : {}) }
          const model = cfg.model ?? endpointCfg.model
          return { ...integrationEnv, ...modelEnv, ...(model ? { ROUTINI_MODEL: model } : {}) }
        })
        for (const v of Object.values(env)) ctx.addSecret(v)

        const output = cfg.repo ? (cfg.output ?? 'pr') : 'none'
        const workBranch = `routini/run-${ctx.run.number}${ctx.run.jobSnapshot.steps.filter((s) => s.kind === 'agent').length > 1 ? `-${ctx.step.id}` : ''}`
        Object.assign(env, {
          ROUTINI_PROMPT: cfg.prompt,
          ROUTINI_SYSTEM_PROMPT: SYSTEM_PROMPT,
          ROUTINI_OUTPUT: output,
          ROUTINI_COMMIT_MESSAGE: `${ctx.run.jobSnapshot.name} (Routini run #${ctx.run.number})`,
          ...(cfg.repo ? { REPO_URL: cfg.repo.url, BASE_BRANCH: cfg.repo.baseBranch, WORK_BRANCH: workBranch } : {}),
          ...(cfg.check ? { CHECK_COMMAND: cfg.check.command } : {}),
        })

        // ── Run ─────────────────────────────────────────────────────────
        const parser = new AgentStreamParser()
        let emitting = Promise.resolve()
        const started = Date.now()
        await ctx.log(`Starting ${cfg.agent} agent (${image})${cfg.repo ? ` on ${cfg.repo.url}@${cfg.repo.baseBranch}` : ''}`)
        const result = await docker.runStreaming(
          {
            image,
            name: `routini-${ctx.run.number}-${ctx.idx}-${randomUUID().slice(0, 8)}`,
            env,
            user: AGENT_USER,
            cpuCount: cfg.resources?.cpus ?? DEFAULT_CPUS,
            memoryBytes: (cfg.resources?.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024,
            labels: { 'routini.managed': 'true', 'routini.org': orgId, 'routini.run': ctx.run.id, 'routini.step': String(ctx.idx) },
          },
          {
            timeoutMs: timeoutSec * 1000,
            signal: ctx.signal,
            onLine: (line, stream) => {
              for (const ev of parser.line(line, stream)) {
                emitting = emitting.then(() => ctx.emit(ev.type, ev.data))
              }
            },
          },
        )
        await emitting
        const facts = parser.facts
        await ctx.addUsage({ costUsd: facts.costUsd, agentSeconds: (Date.now() - started) / 1000 })

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
          await ctx.emit('artifact', { kind: 'branch', branch: facts.pushed.branch, repo: cfg.repo!.url })
          return { status: 'succeeded', output: withBranch }
        }

        // output === 'pr'
        const gh = parseGithubRepo(cfg.repo!.url)
        if (!gh) return { status: 'failed', error: `Pushed ${facts.pushed.branch}, but pull requests are only supported on github.com`, output: withBranch }
        const token = (await db.org(orgId, (q) => getIntegrationCredentials(q, box, orgId, 'github')))['token']
        if (!token) return { status: 'failed', error: `Pushed ${facts.pushed.branch}, but the GitHub integration is not connected, so no pull request was opened`, output: withBranch }
        ctx.addSecret(token)
        const pr = await createPullRequest(
          token,
          {
            ...gh,
            head: facts.pushed.branch,
            base: cfg.repo!.baseBranch,
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
