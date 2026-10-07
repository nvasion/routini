// ─────────────────────────────────────────────────────────────────────────────
// Environment ops on a fleet host: the EnvRuntime and SandboxBroker a
// `host_id`-bound environment uses instead of DockerEnvRuntime / BrokerClient.
// Every call queues an `env` runner task (repos/runners.ts) and waits for it
// with runRunnerTask — the same queue/wait/stream/cancel loop exec and agent
// tasks use. Anything secret (an exec's env, the egress session's credential
// bindings) travels sealed; see createEnvRunnerTask.
//
// A terminal inside a fleet environment does not go through here: it is a
// single interactive session, not a queued task, so it uses
// RunnerGateway.openEnvTty directly (gateway.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto'
import type { Db } from '../db/index.js'
import type { SecretBox } from '../crypto/secrets.js'
import { createEnvRunnerTask, type EnvOp, type ExecResultData } from '../repos/runners.js'
import { sandboxNetworkName, sandboxNetworkPrefix, type SandboxBroker } from '../egress/client.js'
import type { EgressSession, SessionStats } from '../egress/types.js'
import { sandboxHostConfig } from '../services/dockerClient.js'
import { WORKSPACE, type EnvContainerSpec, type EnvRuntime, type ExecResult, type TtySession } from '../services/envRuntime.js'
import { runRunnerTask } from './exec.js'

/** The runner that would carry out an environment op is not connected right now. */
export class EnvHostOfflineError extends Error {
  constructor(host: string) {
    super(`The runner on "${host}" is offline`)
  }
}

interface RunnerEnvOptions {
  db: Db
  box: SecretBox
  orgId: string
  runnerId: string
  hostName: string
  /** How long a queued op waits for an offline runner to reconnect. */
  offlineGraceMs?: number
  pollMs?: number
}

/**
 * Queues one `op` and waits for it. Shared by RunnerEnvRuntime and
 * RunnerBroker: both are thin wrappers that turn their interface's calls into
 * (op, args, secretArgs) and this shape of result back into their own return
 * types.
 */
async function runEnvOp(
  o: RunnerEnvOptions,
  op: EnvOp,
  args: Record<string, unknown>,
  secretArgs: Record<string, unknown> | null = null,
  extra: { signal?: AbortSignal; onLine?: (line: string, stream: 'stdout' | 'stderr') => void } = {},
): Promise<ExecResultData> {
  const outcome = await runRunnerTask(
    { db: o.db, orgId: o.orgId, signal: extra.signal },
    {
      runnerId: o.runnerId,
      hostName: o.hostName,
      offlineGraceMs: o.offlineGraceMs,
      pollMs: o.pollMs,
      create: (q, orgId) => createEnvRunnerTask(q, o.box, orgId, o.runnerId, op, args, secretArgs),
      onLine: extra.onLine ?? (() => {}),
    },
  )
  if (outcome.kind === 'gone') throw new Error('The environment task disappeared')
  const result = outcome.result
  if (!result) throw new Error('The runner returned no result')
  // state() must not fall back to "missing" here: an offline runner tells us
  // nothing about the container, unlike a runner that is up and says so.
  if (result.error === 'offline') throw new EnvHostOfflineError(o.hostName)
  return result
}

/** EnvRuntime backed by a fleet host's routini-runner instead of the local Docker daemon. */
export class RunnerEnvRuntime implements EnvRuntime {
  constructor(private readonly o: RunnerEnvOptions) {}

  async ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    const r = await runEnvOp(this.o, 'volume.ensure', { name, labels })
    failIfError(r)
  }

  async removeVolume(name: string): Promise<void> {
    const r = await runEnvOp(this.o, 'volume.remove', { name })
    failIfError(r)
  }

  async startContainer(spec: EnvContainerSpec): Promise<string> {
    const r = await runEnvOp(
      this.o,
      'container.start',
      { name: spec.name, image: spec.image, volume: spec.volume, labels: spec.labels, cpus: spec.cpus, memoryMb: spec.memoryMb, pidsLimit: sandboxHostConfig().PidsLimit, network: spec.network },
      { env: spec.env ?? {} },
    )
    failIfError(r)
    const containerId = (r.data as { containerId?: unknown } | null)?.containerId
    if (typeof containerId !== 'string' || !containerId) throw new Error('The runner started the container but did not return its id')
    return containerId
  }

  async removeContainer(id: string): Promise<void> {
    const r = await runEnvOp(this.o, 'container.remove', { containerId: id })
    failIfError(r)
  }

  async state(id: string): Promise<'running' | 'stopped' | 'missing'> {
    const r = await runEnvOp(this.o, 'container.state', { containerId: id })
    failIfError(r)
    const state = (r.data as { state?: unknown } | null)?.state
    if (state !== 'running' && state !== 'stopped' && state !== 'missing') throw new Error('The runner returned an unrecognized container state')
    return state
  }

  async exec(
    id: string,
    cmd: string[],
    opts: { env?: Record<string, string>; workdir?: string; timeoutMs: number; signal?: AbortSignal; onLine?: (line: string, stream: 'stdout' | 'stderr') => void },
  ): Promise<ExecResult> {
    const r = await runEnvOp(
      this.o,
      'exec',
      { containerId: id, cmd, workdir: opts.workdir ?? WORKSPACE, timeoutSec: Math.ceil(opts.timeoutMs / 1000) },
      { env: opts.env ?? {} },
      { signal: opts.signal, onLine: opts.onLine },
    )
    // A cancel is the caller's own doing, not a failure to surface as one.
    if (r.error && !r.canceled) throw new Error(r.error)
    return { exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.canceled }
  }

  async execTty(): Promise<TtySession> {
    throw new Error('Terminals on fleet hosts go through RunnerGateway.openEnvTty')
  }

  async pull(image: string): Promise<void> {
    const r = await runEnvOp(this.o, 'pull', { image })
    failIfError(r)
  }
}

const failIfError = (r: ExecResultData): void => {
  if (r.error) throw new Error(r.error)
}

interface RunnerBrokerOptions extends RunnerEnvOptions {
  /** Egress proxy image the runner starts beside sandboxed containers on its host. */
  egressImage: string
}

/**
 * SandboxBroker backed by a fleet host's own egress proxy (its control
 * channel runs over the runner connection, as env.op tasks, instead of HTTP).
 */
export class RunnerBroker implements SandboxBroker {
  private caPem: string | null = null

  constructor(private readonly o: RunnerBrokerOptions) {}

  newToken(): string {
    return randomBytes(24).toString('hex')
  }

  async network(orgId: string): Promise<string> {
    const r = await runEnvOp(this.o, 'network.ensure', { network: sandboxNetworkName(sandboxNetworkPrefix(), orgId), egressImage: this.o.egressImage })
    failIfError(r)
    const network = (r.data as { network?: unknown } | null)?.network
    if (typeof network !== 'string' || !network) throw new Error('The runner did not return the sandbox network name')
    return network
  }

  async open(session: EgressSession): Promise<void> {
    const r = await runEnvOp(this.o, 'session.open', {}, { session })
    failIfError(r)
    const caPem = (r.data as { caPem?: unknown } | null)?.caPem
    if (typeof caPem === 'string' && caPem) this.caPem = caPem
  }

  /** Never throws: closing a session is best-effort cleanup, same as BrokerClient.close. */
  async close(token: string): Promise<SessionStats | null> {
    try {
      const r = await runEnvOp(this.o, 'session.close', { token })
      failIfError(r)
      return (r.data as { egress?: SessionStats } | null)?.egress ?? null
    } catch {
      return null
    }
  }

  async containerEnv(token: string): Promise<Record<string, string>> {
    if (!this.caPem) throw new Error('containerEnv() called before a session was opened on this host')
    const proxy = `http://routini:${token}@routini-egress:3128`
    return {
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: '',
      no_proxy: '',
      // git probes the proxy without credentials by default (anyauth); send Basic up front.
      GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
      ROUTINI_CA_PEM: this.caPem,
    }
  }
}
