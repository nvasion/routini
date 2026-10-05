// ─────────────────────────────────────────────────────────────────────────────
// Built-in step executors: action (http / ssh / imap) and approval.
// The agent executor lives in ./agent.ts (M3).
// ─────────────────────────────────────────────────────────────────────────────

import { runHttpTask } from '../services/http.js'
import { runSshTask, type SshCredentialProvider } from '../services/ssh.js'
import { runImapTask } from '../services/imap.js'
import { getHost } from '../repos/hosts.js'
import { createApproval } from '../repos/runs.js'
import type { ActionConfig, ApprovalConfig } from './spec.js'
import { runFactoryAction } from './factory.js'
import { execOnRunner, STDOUT_TAIL_BYTES } from '../runner/exec.js'
import { shellExports } from './template.js'
import type { EngineOptions, StepContext, StepExecutor, StepResult } from './types.js'

interface ExecutorResult {
  success: boolean
  logs: string[]
  error?: string
}

async function finish(ctx: StepContext, r: ExecutorResult, output: Record<string, unknown> = {}): Promise<StepResult> {
  for (const line of r.logs) await ctx.log(line)
  return r.success ? { status: 'succeeded', output } : { status: 'failed', error: r.error ?? 'Action failed', output }
}

export function actionExecutor(opts: EngineOptions['actions'] = {}): StepExecutor {
  return {
    async execute(ctx) {
      const cfg = ctx.step.config as ActionConfig
      const allowPrivateHosts = ctx.app.config.mode === 'selfhost'
      const task = { id: ctx.run.id, name: ctx.step.name }

      switch (cfg.type) {
        case 'http': {
          const config: Record<string, string> = { url: cfg.url, method: cfg.method ?? 'GET' }
          if (cfg.expectStatus !== undefined) config['expectedStatus'] = String(cfg.expectStatus)
          if (cfg.timeoutMs !== undefined) config['timeout'] = String(cfg.timeoutMs)
          if (cfg.headers) config['headers'] = JSON.stringify(cfg.headers)
          if (cfg.body !== undefined) config['body'] = cfg.body
          const r = await runHttpTask({ ...task, config }, { ...opts.http, allowPrivateHosts })
          return finish(ctx, r, r.statusCode !== undefined ? { statusCode: r.statusCode } : {})
        }

        case 'ssh': {
          if (!cfg.hostId) return { status: 'failed', error: 'This step has no target host' }
          const host = await ctx.app.db.org(ctx.org.id, (q) => getHost(q, ctx.org.id, cfg.hostId!))
          if (!host) return { status: 'failed', error: 'The host this step targets no longer exists' }

          if (host.transport === 'runner') {
            if (!host.runner || host.runner.revoked) return { status: 'failed', error: `Host "${host.name}" has no active runner` }
            await ctx.log(`Host ${host.name} via routini-runner${host.runner.online ? '' : ' (offline; waiting for it to reconnect)'}`)
            const r = await execOnRunner(ctx, {
              runnerId: host.runner.id,
              hostName: host.name,
              command: cfg.command,
              env: cfg.env,
              timeoutSec: ctx.step.timeoutSec ?? 600,
              offlineGraceMs: opts.runnerOfflineGraceMs,
              pollMs: opts.runnerPollMs,
            })
            const output = { hostId: host.id, exitCode: r.exitCode, stdout: r.stdout }
            return r.ok ? { status: 'succeeded', output } : { status: 'failed', error: r.error, output }
          }

          if (!host.credentialKey || !host.username) return { status: 'failed', error: `Host "${host.name}" has no credential configured` }
          const secret = await ctx.secret(host.credentialKey)
          if (!secret) return { status: 'failed', error: `Credential "${host.credentialKey}" for host "${host.name}" is missing` }
          const passphrase = host.auth === 'key' ? await ctx.secret(`${host.credentialKey}.passphrase`) : null
          const credentialProvider: SshCredentialProvider = {
            async get(name) {
              if (name === 'SSH_PRIVATE_KEY') return host.auth === 'key' ? secret : undefined
              if (name === 'SSH_PASSWORD') return host.auth === 'password' ? secret : undefined
              if (name === 'SSH_KEY_PASSPHRASE') return passphrase ?? undefined
              return undefined
            },
          }
          await ctx.log(`Host ${host.name} (${host.username}@${host.address}:${host.port})`)
          // Template values travel as exports we quote ourselves (SSH servers rarely accept env).
          const command = cfg.env && Object.keys(cfg.env).length ? shellExports(cfg.env) + cfg.command : cfg.command
          const r = await runSshTask(
            { ...task, config: { host: host.address, port: String(host.port), username: host.username, command } },
            { credentialProvider, allowPrivateHosts, allowShellSyntax: true, executor: opts.sshExecutor },
          )
          return finish(ctx, r, { hostId: host.id, exitCode: r.exitCode ?? null, stdout: (r.stdout ?? '').slice(-STDOUT_TAIL_BYTES) })
        }

        case 'factory':
          return runFactoryAction(ctx, cfg, { fetchImpl: opts.factoryFetch, pollMs: opts.factoryPollMs })

        case 'imap': {
          const password = await ctx.secret(cfg.credentialKey)
          if (!password) return { status: 'failed', error: `Credential "${cfg.credentialKey}" is missing` }
          const config: Record<string, string> = { host: cfg.host, username: cfg.username }
          if (cfg.port !== undefined) config['port'] = String(cfg.port)
          if (cfg.mailbox) config['mailbox'] = cfg.mailbox
          if (cfg.search) config['searchCriteria'] = cfg.search
          if (cfg.tls !== undefined) config['tls'] = String(cfg.tls)
          const r = await runImapTask({ ...task, config }, { credentialResolver: () => password, executor: opts.imapExecutor })
          return finish(ctx, r, r.messageCount !== undefined ? { messageCount: r.messageCount } : {})
        }
      }
    },
  }
}

/** Opens an approval and parks the run; the approve/deny API completes the step. */
export const approvalExecutor: StepExecutor = {
  async execute(ctx) {
    const cfg = ctx.step.config as ApprovalConfig
    await ctx.app.db.org(ctx.org.id, (q) => createApproval(q, ctx.run, ctx.idx, cfg.message, cfg.minRole ?? 'member'))
    return { status: 'waiting' }
  },
}

/** Placeholder until the agent runner (M3) is registered. */
export const unavailableAgentExecutor: StepExecutor = {
  async execute() {
    return { status: 'failed', error: 'No agent runner is configured on this server' }
  },
}
