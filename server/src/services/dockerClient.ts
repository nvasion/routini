// ─────────────────────────────────────────────────────────────────────────────
// The Docker client every service uses by default.
//
// Without extra settings, Dockerode follows DOCKER_HOST (the local socket, or
// ssh:// / tcp:// for a separate agent host) and DOCKER_CERT_PATH. Platforms
// that cannot mount certificate files (App Platform) pass the client
// certificate as PEM text instead:
//
//   DOCKER_HOST=tcp://10.124.0.5:2376
//   ROUTINI_DOCKER_TLS_CA / ROUTINI_DOCKER_TLS_CERT / ROUTINI_DOCKER_TLS_KEY
//   ROUTINI_DOCKER_TLS_SERVER_NAME=routini-agents   (optional: the name the
//     daemon certificate must carry, instead of the address in DOCKER_HOST)
//
// which verifies the daemon against the CA and authenticates with the client
// certificate (mutual TLS: the daemon only accepts clients signed by its CA).
// ─────────────────────────────────────────────────────────────────────────────

import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import Dockerode from 'dockerode'

export function dockerOptions(env: NodeJS.ProcessEnv = process.env): Dockerode.DockerOptions | undefined {
  const ca = env['ROUTINI_DOCKER_TLS_CA']?.trim()
  const cert = env['ROUTINI_DOCKER_TLS_CERT']?.trim()
  const key = env['ROUTINI_DOCKER_TLS_KEY']?.trim()
  if (!ca && !cert && !key) return undefined
  if (!ca || !cert || !key) {
    throw new Error('ROUTINI_DOCKER_TLS_CA, ROUTINI_DOCKER_TLS_CERT and ROUTINI_DOCKER_TLS_KEY must be set together')
  }
  const hostEnv = env['DOCKER_HOST']?.trim()
  if (!hostEnv?.startsWith('tcp://')) throw new Error('Docker TLS settings need DOCKER_HOST=tcp://host:port')
  const url = new URL(hostEnv)
  // docker-modem passes checkServerIdentity to TLS; @types/dockerode does not declare it.
  const options: Dockerode.DockerOptions & { checkServerIdentity?: typeof checkServerIdentity } = {
    protocol: 'https',
    host: url.hostname,
    port: Number(url.port || 2376),
    ca,
    cert,
    key,
  }
  // The daemon's certificate can name the host instead of its address, so it
  // can be issued before the host (and its private IP) exists.
  const serverName = env['ROUTINI_DOCKER_TLS_SERVER_NAME']?.trim()
  if (serverName) options.checkServerIdentity = (_host: string, peer: PeerCertificate) => checkServerIdentity(serverName, peer)
  return options
}

/** The Docker host's name for the timeline: the pinned TLS name, else DOCKER_HOST's host, else the local daemon. */
export function dockerHostLabel(env: NodeJS.ProcessEnv = process.env): string {
  const serverName = env['ROUTINI_DOCKER_TLS_SERVER_NAME']?.trim()
  if (serverName) return serverName
  const hostEnv = env['DOCKER_HOST']?.trim()
  if (hostEnv && /^(tcp|ssh|https?):\/\//.test(hostEnv)) {
    try {
      const host = new URL(hostEnv).hostname
      if (host) return host
    } catch {
      // fall through to the local daemon
    }
  }
  return 'local Docker'
}

const DEFAULT_PIDS_LIMIT = 512

/**
 * HostConfig every sandbox container (agent runs, environments) gets on top of
 * its own limits: a PID cap so a fork bomb can't starve other tenants, and the
 * OCI runtime when ROUTINI_CONTAINER_RUNTIME is set (e.g. `runsc` for gVisor,
 * which gives each container its own kernel). ROUTINI_CONTAINER_PIDS_LIMIT
 * overrides the cap.
 */
export function sandboxHostConfig(env: NodeJS.ProcessEnv = process.env): { PidsLimit: number; Runtime?: string } {
  const raw = env['ROUTINI_CONTAINER_PIDS_LIMIT']?.trim()
  const pids = raw ? Number(raw) : DEFAULT_PIDS_LIMIT
  if (!Number.isInteger(pids) || pids < 16) throw new Error('ROUTINI_CONTAINER_PIDS_LIMIT must be an integer of at least 16')
  const runtime = env['ROUTINI_CONTAINER_RUNTIME']?.trim()
  if (runtime && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runtime)) throw new Error(`Invalid ROUTINI_CONTAINER_RUNTIME: "${runtime}"`)
  return { PidsLimit: pids, ...(runtime ? { Runtime: runtime } : {}) }
}

let shared: Dockerode | undefined

/** One client per process, built from the environment on first use. */
export function dockerFromEnv(): Dockerode {
  shared ??= new Dockerode(dockerOptions())
  return shared
}
