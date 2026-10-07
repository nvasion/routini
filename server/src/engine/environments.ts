// ─────────────────────────────────────────────────────────────────────────────
// Environment manager: lifecycle on top of the EnvRuntime, with the database
// as the source of truth for what should exist.
//
//   create → row 'starting' → volume + container → clone repo → 'running'
//   stop   → container removed, volume kept → 'stopped'
//   start  → fresh container on the same volume → 'running'
//   delete → container and volume removed → row deleted
//
// Provisioning runs in the background (create/start return immediately); the
// sweeper reconciles rows with Docker, fails provisioning that never finished,
// and stops environments idle past their timeout.
// ─────────────────────────────────────────────────────────────────────────────

import type { Db } from '../db/index.js'
import type { SecretBox } from '../crypto/secrets.js'
import {
  addEnvironmentEvent,
  countRunningEnvironments,
  getEnvironment,
  listActiveEnvironmentsSystem,
  setEnvironmentState,
  touchEnvironment,
  type Environment,
  setEnvironmentEgressToken,
} from '../repos/environments.js'
import { getPolicy } from '../repos/policy.js'
import { INTEGRATIONS } from '../integrations/catalog.js'
import type { BrokerClient, SandboxBroker } from '../egress/client.js'
import { PLACEHOLDER, type CredentialBinding } from '../egress/types.js'
import { getIntegrationCredentials } from '../repos/integrations.js'
import { effectiveLimits, getOrgById, orgHasVerifiedOwner } from '../repos/identity.js'
import type { EnvRuntime } from '../services/envRuntime.js'
import { redact } from '../utils/redact.js'
import { getHost } from '../repos/hosts.js'
import { EnvHostOfflineError, RunnerBroker, RunnerEnvRuntime } from '../runner/env.js'
import { fleetEgressImage } from './fleetImages.js'

export class EnvError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const PROVISION_TIMEOUT_MS = 10 * 60 * 1000
const STUCK_AFTER_MS = 15 * 60 * 1000

export function repoDirName(url: string): string {
  const last = url.replace(/\/+$/, '').split('/').pop() ?? 'repo'
  return last.replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]/g, '-') || 'repo'
}

/** Where an environment's container actually lives: Routini's own Docker host, or a fleet host's runner. */
export interface EnvPlacement {
  runtime: EnvRuntime
  broker: SandboxBroker | null
  /** Set for a fleet environment (env.hostId); null for one on Routini's own Docker host. */
  host: { id: string; name: string; runnerId: string } | null
}

export interface EnvManager {
  runtime: EnvRuntime
  /**
   * Where this environment runs: Routini's own runtime/broker (hostId null), or a
   * fleet host's, backed by its routini-runner. Fleet environments are always brokered.
   */
  placement(env: Environment): Promise<EnvPlacement>
  /** Starts provisioning a new (already inserted, 'starting') environment in the background. */
  provision(env: Environment, userId: string | null): Promise<void>
  start(orgId: string, id: string, userId: string | null): Promise<Environment>
  stop(orgId: string, id: string, userId: string | null, reason?: string): Promise<Environment>
  destroy(orgId: string, id: string, userId: string | null): Promise<void>
  /** Starts the environment if needed and waits until it is running. */
  ensureRunning(orgId: string, id: string): Promise<Environment>
  touch(orgId: string, id: string): Promise<void>
  /** Reconcile with Docker; stop idle environments. Returns how many changed. */
  sweep(now?: Date): Promise<number>
  /** Waits for any background provisioning (tests). */
  idle(): Promise<void>
}

/** Writes Routini's CA into the user's trust bundle and login profile (credential broker). */
const CA_SETUP = [
  'd="$HOME/.routini"; mkdir -p "$d"',
  'printf \'%s\\n\' "$ROUTINI_CA_PEM" > "$d/ca.pem"',
  '{ cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null; cat "$d/ca.pem"; } > "$d/bundle.pem"',
  'line="export NODE_EXTRA_CA_CERTS=$d/ca.pem SSL_CERT_FILE=$d/bundle.pem GIT_SSL_CAINFO=$d/bundle.pem REQUESTS_CA_BUNDLE=$d/bundle.pem CURL_CA_BUNDLE=$d/bundle.pem"',
  'for f in "$HOME/.profile" "$HOME/.bashrc"; do grep -qs "routini/bundle.pem" "$f" || echo "$line" >> "$f"; done',
].join('\n')

const ENV_SESSION_HOURS = 24

export function createEnvManager(deps: {
  db: Db
  box: SecretBox
  runtime: EnvRuntime
  broker?: BrokerClient | null
  mode?: 'selfhost' | 'hosted'
  /** Starting needs an org owner with a verified email (config.requireVerifiedEmail). */
  requireVerifiedEmail?: boolean
  /** Egress proxy image a fleet host runs beside a fleet environment's container. Default: ROUTINI_FLEET_EGRESS_IMAGE. */
  fleetEgressImage?: string
  /** A fleet environment's ops: how long to wait for an offline runner, and the result poll interval. */
  runnerOfflineGraceMs?: number
  runnerPollMs?: number
}): EnvManager {
  const { db, box, runtime } = deps
  const broker = deps.broker ?? null

  /** (Re)registers an environment's own egress session: org allow-list, its repo, GitHub for clone/push. */
  async function openEnvSession(env: Environment, token: string, sessionBroker: SandboxBroker | null): Promise<void> {
    if (!sessionBroker) return
    const { hosts, bindings } = await db.org(env.orgId, async (q) => {
      const policy = await getPolicy(q, env.orgId, deps.mode ?? 'selfhost')
      const creds = await getIntegrationCredentials(q, box, env.orgId, 'github')
      const gh = INTEGRATIONS.find((d) => d.id === 'github')!
      const bindings: CredentialBinding[] = creds['token']
        ? (gh.broker ?? []).filter((r) => r.host).map((r) => ({ host: r.host!, header: r.header, format: r.format, secret: creds['token']! }))
        : []
      const hosts = new Set([...policy.egress.allowedHosts, ...bindings.map((b) => b.host)])
      if (env.repo) hosts.add(new URL(env.repo.url).hostname)
      return { hosts: [...hosts], bindings }
    })
    await sessionBroker.open({
      token,
      orgId: env.orgId,
      label: `env:${env.id}`,
      allowedHosts: hosts,
      bindings,
      expiresAt: new Date(Date.now() + ENV_SESSION_HOURS * 3600_000).toISOString(),
    })
  }

  /** Where env runs: Routini's own runtime/broker, or (hostId set) a fleet host's runner. */
  async function placement(env: Environment): Promise<EnvPlacement> {
    if (!env.hostId) return { runtime, broker, host: null }
    const host = await db.org(env.orgId, (q) => getHost(q, env.orgId, env.hostId!))
    if (!host) throw new EnvError(409, "The environment's host has no active runner")
    if (!host.runner || host.runner.revoked) {
      throw new EnvError(409, `The environment's host "${host.name}" has no active runner`)
    }
    const runnerOpts = {
      db,
      box,
      orgId: env.orgId,
      runnerId: host.runner.id,
      hostName: host.name,
      offlineGraceMs: deps.runnerOfflineGraceMs,
      pollMs: deps.runnerPollMs,
    }
    return {
      runtime: new RunnerEnvRuntime(runnerOpts),
      broker: new RunnerBroker({ ...runnerOpts, egressImage: deps.fleetEgressImage ?? fleetEgressImage() }),
      host: { id: host.id, name: host.name, runnerId: host.runner.id },
    }
  }
  const pending = new Set<Promise<unknown>>()
  const track = <T>(p: Promise<T>) => {
    pending.add(p)
    void p.finally(() => pending.delete(p))
    return p
  }

  const labels = (env: Environment) => ({ 'routini.managed': 'true', 'routini.org': env.orgId, 'routini.environment': env.id })

  async function load(orgId: string, id: string): Promise<Environment> {
    const env = await db.org(orgId, (q) => getEnvironment(q, orgId, id))
    if (!env) throw new EnvError(404, 'Environment not found')
    return env
  }

  async function checkCapacity(env: Environment): Promise<void> {
    if (deps.requireVerifiedEmail && !(await orgHasVerifiedOwner(db, env.orgId))) {
      throw new EnvError(403, 'Verify your email address (Settings → Account) before starting environments')
    }
    const org = await getOrgById(db, env.orgId)
    const limit = effectiveLimits(org?.plan ?? 'free', org?.limits).maxRunningEnvironments
    const running = await db.org(env.orgId, (q) => countRunningEnvironments(q, env.orgId, env.id))
    if (running >= limit) throw new EnvError(409, `This org can run ${limit} environment${limit === 1 ? '' : 's'} at a time; stop one first`)
  }

  async function bringUp(env: Environment, cloneRepo: boolean, userId: string | null): Promise<void> {
    let placed: EnvPlacement | null = null
    try {
      placed = await placement(env)
      const { runtime, broker } = placed
      await runtime.ensureVolume(env.volume, labels(env))
      if (env.containerId) await runtime.removeContainer(env.containerId)
      // Under the broker: the org's sandbox network, its own egress session, and Routini's CA.
      // Fleet environments are always brokered (placed.broker is never null when env.hostId is set).
      let network: string | undefined
      let brokerEnv: Record<string, string> = {}
      if (broker) {
        const token = env.egressToken ?? broker.newToken()
        network = await broker.network(env.orgId)
        await openEnvSession(env, token, broker)
        await db.org(env.orgId, (q) => setEnvironmentEgressToken(q, env.orgId, env.id, token))
        brokerEnv = await broker.containerEnv(token)
      }
      const containerId = await runtime.startContainer({
        name: `routini-env-${env.id.slice(0, 8)}-${Date.now().toString(36)}`,
        image: env.image,
        volume: env.volume,
        labels: labels(env),
        cpus: env.cpus,
        memoryMb: env.memoryMb,
        network,
        env: brokerEnv,
      })
      await db.org(env.orgId, (q) => setEnvironmentState(q, env.orgId, env.id, { status: 'starting', detail: 'container started', containerId }))
      if (broker) {
        const r = await runtime.exec(containerId, ['bash', '-c', CA_SETUP], { timeoutMs: 30_000 })
        if (r.exitCode !== 0) throw new Error('Could not install the egress CA in the environment')
      }

      if (cloneRepo && env.repo) {
        const creds = await db.org(env.orgId, (q) => getIntegrationCredentials(q, box, env.orgId, 'github'))
        const output: string[] = []
        const secrets = creds['token'] ? [creds['token']] : []
        // Without the broker the token goes only to this one process (nothing on disk);
        // with it, the process gets a placeholder and the proxy adds the token.
        const token = broker ? (creds['token'] ? PLACEHOLDER : undefined) : creds['token']
        const r = await runtime.exec(
          containerId,
          [
            'bash',
            broker ? '-lc' : '-c',
            'if [ -d "$DIR/.git" ]; then exit 0; fi; ' +
              'git -c credential.helper=\'!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f\' ' +
              'clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"',
          ],
          {
            env: { REPO_URL: env.repo.url, BRANCH: env.repo.branch, DIR: `/workspace/${env.repo.dir}`, ...(token ? { GITHUB_TOKEN: token } : {}) },
            timeoutMs: PROVISION_TIMEOUT_MS,
            onLine: (l) => output.push(redact(l, secrets)),
          },
        )
        if (r.exitCode !== 0) {
          throw new Error(`Cloning ${env.repo.url}@${env.repo.branch} failed${output.length ? `: ${output.slice(-3).join(' ')}` : ''}`)
        }
      }
      await db.org(env.orgId, async (q) => {
        await setEnvironmentState(q, env.orgId, env.id, { status: 'running', detail: null, containerId })
        await touchEnvironment(q, env.orgId, env.id)
        await addEnvironmentEvent(q, env.orgId, env.id, cloneRepo ? 'created' : 'started', userId)
      })
    } catch (err) {
      const msg = (err as Error).message.slice(0, 1000)
      console.error(`[environments] ${env.id} failed to start:`, msg)
      const current = await db.org(env.orgId, (q) => getEnvironment(q, env.orgId, env.id)).catch(() => null)
      if (current?.containerId && placed) await placed.runtime.removeContainer(current.containerId).catch(() => {})
      await db
        .org(env.orgId, async (q) => {
          await setEnvironmentState(q, env.orgId, env.id, { status: 'failed', detail: msg, containerId: null })
          await addEnvironmentEvent(q, env.orgId, env.id, 'failed', userId, { error: msg })
        })
        .catch(() => {})
    }
  }

  const manager: EnvManager = {
    runtime,
    placement,

    async provision(env, userId) {
      await checkCapacity(env)
      void track(bringUp(env, true, userId))
    },

    async start(orgId, id, userId) {
      const env = await load(orgId, id)
      if (env.status === 'running' || env.status === 'starting') return env
      if (env.status === 'deleting' || env.status === 'stopping') throw new EnvError(409, `Environment is ${env.status}`)
      await checkCapacity(env)
      await db.org(orgId, (q) => setEnvironmentState(q, orgId, id, { status: 'starting', detail: null }))
      // A failed environment that never got its repo retries the clone.
      void track(bringUp({ ...env, status: 'starting' }, env.status === 'failed', userId))
      return { ...env, status: 'starting', statusDetail: null }
    },

    async stop(orgId, id, userId, reason = 'stopped') {
      const env = await load(orgId, id)
      if (env.status === 'stopped') return env
      if (env.status === 'deleting') throw new EnvError(409, 'Environment is being deleted')
      const placed = await placement(env)
      await db.org(orgId, (q) => setEnvironmentState(q, orgId, id, { status: 'stopping', detail: null }))
      if (env.containerId) await placed.runtime.removeContainer(env.containerId)
      if (placed.broker && env.egressToken) await placed.broker.close(env.egressToken)
      await db.org(orgId, async (q) => {
        await setEnvironmentState(q, orgId, id, { status: 'stopped', detail: reason === 'stopped' ? null : reason, containerId: null })
        await addEnvironmentEvent(q, orgId, id, 'stopped', userId, reason === 'stopped' ? {} : { reason })
      })
      return load(orgId, id)
    },

    async destroy(orgId, id, userId) {
      const env = await load(orgId, id)
      const placed = await placement(env)
      await db.org(orgId, async (q) => {
        await setEnvironmentState(q, orgId, id, { status: 'deleting' })
        await addEnvironmentEvent(q, orgId, id, 'deleting', userId)
      })
      if (placed.broker && env.egressToken) await placed.broker.close(env.egressToken)
      if (env.containerId) await placed.runtime.removeContainer(env.containerId)
      await placed.runtime.removeVolume(env.volume)
      await db.org(orgId, (q) => q.query('DELETE FROM environments WHERE org_id = $1 AND id = $2', [orgId, id]))
    },

    async ensureRunning(orgId, id) {
      let env = await load(orgId, id)
      if (env.status === 'stopped' || env.status === 'failed') env = await manager.start(orgId, id, null)
      const deadline = Date.now() + PROVISION_TIMEOUT_MS
      while (env.status === 'starting' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250))
        env = await load(orgId, id)
      }
      if (env.status !== 'running' || !env.containerId) {
        throw new EnvError(409, `Environment "${env.name}" is ${env.status}${env.statusDetail ? `: ${env.statusDetail}` : ''}`)
      }
      return env
    },

    async touch(orgId, id) {
      await db.org(orgId, (q) => touchEnvironment(q, orgId, id))
    },

    async sweep(now = new Date()) {
      const envs = await db.system((q) => listActiveEnvironmentsSystem(q))
      let changed = 0
      for (const env of envs) {
        try {
          if (env.status === 'starting') {
            if (now.getTime() - new Date(env.updatedAt).getTime() > STUCK_AFTER_MS) {
              await db.org(env.orgId, (q) => setEnvironmentState(q, env.orgId, env.id, { status: 'failed', detail: 'Provisioning did not finish' }))
              changed++
            }
            continue
          }
          if (env.status === 'running') {
            if (env.hostId) {
              // Offline or revoked runner: leave it running untouched. Reconnecting is what
              // restores its session (the next sweep after that renews it below).
              const host = await db.org(env.orgId, (q) => getHost(q, env.orgId, env.hostId!))
              if (!host?.runner || !host.runner.online || host.runner.revoked) continue
            }
            let placed: EnvPlacement
            let state: 'running' | 'stopped' | 'missing'
            try {
              placed = await placement(env)
              state = env.containerId ? await placed.runtime.state(env.containerId) : 'missing'
            } catch (err) {
              if (err instanceof EnvError || err instanceof EnvHostOfflineError) continue
              throw err
            }
            if (state !== 'running') {
              if (env.containerId) await placed.runtime.removeContainer(env.containerId).catch(() => {})
              await db.org(env.orgId, async (q) => {
                await setEnvironmentState(q, env.orgId, env.id, { status: 'stopped', detail: 'The container exited', containerId: null })
                await addEnvironmentEvent(q, env.orgId, env.id, 'stopped', null, { reason: 'container exited' })
              })
              changed++
              continue
            }
            const idleMs = now.getTime() - new Date(env.lastActiveAt).getTime()
            if (idleMs > env.idleMinutes * 60_000) {
              await manager.stop(env.orgId, env.id, null, `idle for ${env.idleMinutes} minutes`)
              changed++
            } else if (placed.broker && env.egressToken) {
              // Keep the environment's egress session alive (and pick up allow-list changes);
              // this is also what restores a fleet environment's session after its runner reconnects.
              await openEnvSession(env, env.egressToken, placed.broker)
            }
          }
        } catch (err) {
          console.error(`[environments] sweep of ${env.id} failed:`, (err as Error).message)
        }
      }
      return changed
    },

    async idle() {
      while (pending.size) await Promise.allSettled([...pending])
    },
  }
  return manager
}
