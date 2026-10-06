// ─────────────────────────────────────────────────────────────────────────────
// Broker client (API / worker side).
//
// When the credential broker is configured, sandboxed containers (agent runs,
// environments) join a per-org *internal* Docker network whose only way out
// is the egress proxy. Before a container starts, a session is registered with
// the proxy over its control channel: an allow-list plus credential bindings
// (host → header → secret). The container gets the proxy address, Routini's CA
// and placeholder tokens; the real secrets stay with the proxy.
//
// Per-org networks keep one org's containers from reaching another's.
// ─────────────────────────────────────────────────────────────────────────────

import Dockerode from 'dockerode'
import { dockerFromEnv } from '../services/dockerClient.js'
import { randomBytes } from 'node:crypto'
import type { EgressSession, SessionStats } from './types.js'

export interface BrokerConfig {
  /** Control API of the proxy, reachable from this process (e.g. http://routini-egress:3129). */
  controlUrl: string
  secret: string
  /** Proxy hostname as seen from sandboxed containers (a network alias). */
  proxyHost: string
  proxyPort: number
  /** Name of the proxy container, attached to each org network. */
  proxyContainer: string
  networkPrefix: string
}

export class BrokerError extends Error {}

export class BrokerClient {
  private ca: string | null = null
  private readonly ready = new Map<string, Promise<string>>()

  constructor(
    readonly cfg: BrokerConfig,
    private readonly docker: Dockerode = dockerFromEnv(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async control<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.controlUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.secret}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new BrokerError(`Egress proxy ${method} ${path} failed (HTTP ${res.status})`)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }

  /** Routini's CA certificate (PEM), which sandboxed containers must trust. */
  async caPem(): Promise<string> {
    if (!this.ca) this.ca = (await this.control<{ pem: string }>('GET', '/ca')).pem
    return this.ca
  }

  /** Ensures the org's internal network exists and the proxy is attached to it. Returns its name. */
  network(orgId: string): Promise<string> {
    // The full org id: a prefix could collide and put two orgs on one network.
    const name = `${this.cfg.networkPrefix}-${orgId}`
    let p = this.ready.get(name)
    if (!p) {
      p = this.ensureNetwork(name, orgId).catch((err) => {
        this.ready.delete(name)
        throw err
      })
      this.ready.set(name, p)
    }
    return p
  }

  private async ensureNetwork(name: string, orgId: string): Promise<string> {
    const existing = await this.docker.listNetworks({ filters: { name: [name] } })
    if (!existing.some((n) => n.Name === name)) {
      try {
        // Internal: no gateway to the outside world; the proxy is the only exit.
        await this.docker.createNetwork({ Name: name, Internal: true, Labels: { 'routini.managed': 'true', 'routini.org': orgId } })
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 409) throw err
      }
    }
    try {
      await this.docker.getNetwork(name).connect({ Container: this.cfg.proxyContainer, EndpointConfig: { Aliases: [this.cfg.proxyHost] } })
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      const msg = (err as Error).message ?? ''
      // 403/409 "already exists in network" is fine.
      if (!(code === 403 || code === 409 || /already exists/i.test(msg))) throw err
    }
    return name
  }

  newToken(): string {
    return randomBytes(24).toString('hex')
  }

  async open(session: EgressSession): Promise<void> {
    await this.control('PUT', `/sessions/${session.token}`, session)
  }

  /** Ends a session; returns what happened during it (null if the proxy no longer knew it). */
  async close(token: string): Promise<SessionStats | null> {
    try {
      return await this.control<SessionStats>('DELETE', `/sessions/${token}`)
    } catch {
      return null
    }
  }

  /** Environment for a sandboxed process using `token`. */
  async containerEnv(token: string): Promise<Record<string, string>> {
    const proxy = `http://routini:${token}@${this.cfg.proxyHost}:${this.cfg.proxyPort}`
    return {
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: '',
      no_proxy: '',
      // git probes the proxy without credentials by default (anyauth); send Basic up front.
      GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
      ROUTINI_CA_PEM: await this.caPem(),
    }
  }
}

export function brokerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerConfig | null {
  const controlUrl = env['ROUTINI_EGRESS_CONTROL_URL']?.trim()
  const secret = env['ROUTINI_EGRESS_SECRET']?.trim()
  if (!controlUrl || !secret) return null
  return {
    controlUrl: controlUrl.replace(/\/+$/, ''),
    secret,
    proxyHost: env['ROUTINI_EGRESS_PROXY_HOST']?.trim() || 'routini-egress',
    proxyPort: Number(env['ROUTINI_EGRESS_PROXY_PORT'] ?? 3128),
    proxyContainer: env['ROUTINI_EGRESS_CONTAINER']?.trim() || 'routini-egress',
    networkPrefix: env['ROUTINI_SANDBOX_NETWORK_PREFIX']?.trim() || 'routini-sb',
  }
}
