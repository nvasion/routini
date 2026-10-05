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

let shared: Dockerode | undefined

/** One client per process, built from the environment on first use. */
export function dockerFromEnv(): Dockerode {
  shared ??= new Dockerode(dockerOptions())
  return shared
}
