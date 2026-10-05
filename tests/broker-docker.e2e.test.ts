// Opt-in end-to-end for the credential broker on a real Docker daemon:
// the real egress proxy container, a per-org internal network, and the fake
// agent image making HTTPS requests from inside the sandbox.
//   ROUTINI_E2E_DOCKER=1 npx vitest run tests/broker-docker.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerClient } from '../server/src/egress/client'
import { generateCa, LeafIssuer } from '../server/src/egress/ca'
import { DockerService } from '../server/src/services/docker'
import { PLACEHOLDER } from '../server/src/egress/types'

const enabled = process.env['ROUTINI_E2E_DOCKER'] === '1'
const SECRET = 'e2e-control-secret-0123456789'
const ORG = '11111111-2222-3333-4444-555555555555'
const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'pipe' }).toString().trim()

describe.skipIf(!enabled)('credential broker (real Docker)', () => {
  let dir: string
  let broker: BrokerClient
  let network: string
  const service = new DockerService()

  beforeAll(async () => {
    const root = join(__dirname, '..')
    docker('build', '-q', '-t', 'routini/server:e2e', join(root, 'server'))
    docker('build', '-q', '-f', join(root, 'agents/fake/Dockerfile'), '-t', 'routini/agent-fake:test', join(root, 'agents'))

    // An HTTPS "upstream" with a private CA the proxy trusts (NODE_EXTRA_CA_CERTS).
    dir = mkdtempSync(join(tmpdir(), 'routini-broker-'))
    const upstreamCa = generateCa('Upstream E2E CA')
    const leaf = new LeafIssuer(upstreamCa).pemFor('echo.routini.test')
    writeFileSync(join(dir, 'upstream-ca.pem'), upstreamCa.certPem)
    writeFileSync(join(dir, 'echo-cert.pem'), leaf.certPem)
    writeFileSync(join(dir, 'echo-key.pem'), leaf.keyPem)
    writeFileSync(
      join(dir, 'echo.js'),
      `require('https').createServer({cert:require('fs').readFileSync('/e/echo-cert.pem'),key:require('fs').readFileSync('/e/echo-key.pem')},(q,s)=>s.end(JSON.stringify({auth:q.headers.authorization||null}))).listen(443)`,
    )
    chmodSync(dir, 0o755)

    for (const c of ['routini-e2e-egress', 'routini-e2e-echo']) execFileSync('docker', ['rm', '-f', c], { stdio: 'ignore' })
    try {
      execFileSync('docker', ['network', 'rm', 'routini-e2e-up'], { stdio: 'ignore' })
    } catch {
      // did not exist
    }
  }, 600_000)

  afterAll(async () => {
    for (const c of ['routini-e2e-egress', 'routini-e2e-echo']) execFileSync('docker', ['rm', '-f', c], { stdio: 'ignore' })
    for (const n of ['routini-e2e-up', network].filter(Boolean)) {
      try {
        execFileSync('docker', ['network', 'rm', n], { stdio: 'ignore' })
      } catch {
        // already gone
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('sandboxed containers reach only allowed hosts, and only the proxy holds the credential', async () => {
    docker('network', 'create', 'routini-e2e-up')
    docker('run', '-d', '--name', 'routini-e2e-echo', '--network', 'routini-e2e-up', '--network-alias', 'echo.routini.test', '-v', `${dir}:/e:ro`, 'node:22-slim', 'node', '/e/echo.js')
    docker(
      'run', '-d', '--name', 'routini-e2e-egress', '--network', 'routini-e2e-up',
      '-e', `ROUTINI_EGRESS_SECRET=${SECRET}`, '-e', 'NODE_EXTRA_CA_CERTS=/e/upstream-ca.pem',
      '-v', `${dir}:/e:ro`, '-p', '127.0.0.1::3129', 'routini/server:e2e', 'node', 'dist/egress.js',
    )
    const controlPort = docker('port', 'routini-e2e-egress', '3129/tcp').split(':').pop()
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${controlPort}/health`)).ok) break
      } catch {
        // starting
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    broker = new BrokerClient(
      { controlUrl: `http://127.0.0.1:${controlPort}`, secret: SECRET, proxyHost: 'routini-egress', proxyPort: 3128, proxyContainer: 'routini-e2e-egress', networkPrefix: 'routini-e2e-sb' },
    )
    network = await broker.network(ORG)
    const info = JSON.parse(docker('network', 'inspect', network))[0]
    expect(info.Internal).toBe(true)

    const token = broker.newToken()
    await broker.open({
      token,
      orgId: ORG,
      label: 'e2e',
      allowedHosts: ['echo.routini.test', 'example.com'],
      bindings: [{ host: 'echo.routini.test', header: 'authorization', format: 'bearer', secret: 'REAL-SECRET-VALUE' }],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })

    const lines: string[] = []
    const result = await service.runStreaming(
      {
        image: 'routini/agent-fake:test',
        name: `routini-e2e-agent-${Date.now()}`,
        user: '1000:1000',
        network,
        env: { ...(await broker.containerEnv(token)), GITHUB_TOKEN: PLACEHOLDER, ROUTINI_PROMPT: 'NET https://echo.routini.test/ https://blocked.example/ https://example.com/' },
      },
      { timeoutMs: 60_000, onLine: (l) => lines.push(l) },
    )
    expect(result.exitCode).toBe(0)
    const net = Object.fromEntries(lines.filter((l) => l.startsWith('net ')).map((l) => [l.split(' ')[1], l]))
    // Intercepted: the echo server saw the real secret although the container sent the placeholder.
    expect(net['https://echo.routini.test/']).toContain('200 {"auth":"Bearer REAL-SECRET-VALUE"}')
    // Not on the allow-list: the proxy refused the tunnel.
    expect(net['https://blocked.example/']).not.toContain(' 200 ')
    // Allowed but unbound: tunnelled to the real internet, with the real certificate.
    expect(net['https://example.com/']).toMatch(/ 200 .*Example Domain/)

    const stats = await broker.close(token)
    expect(stats).toMatchObject({ blocked: ['blocked.example'] })
    expect(stats!.intercepted).toBeGreaterThanOrEqual(1)

    // Without the proxy there is no way out of the sandbox network.
    const direct = execFileSync('docker', ['run', '--rm', '--network', network, '--entrypoint', 'sh', 'routini/agent-fake:test', '-c', 'curl -s -m 5 --noproxy "*" https://example.com/ >/dev/null && echo reachable || echo unreachable'], { stdio: 'pipe' }).toString().trim()
    expect(direct).toBe('unreachable')

    // A session that was closed no longer works.
    const after = execFileSync('docker', ['run', '--rm', '--network', network, '-e', `HTTPS_PROXY=http://routini:${token}@routini-egress:3128`, '--entrypoint', 'sh', 'routini/agent-fake:test', '-c', 'curl -s -m 5 -o /dev/null -w "%{http_code}" https://example.com/ || true'], { stdio: 'pipe' }).toString().trim()
    expect(after).not.toBe('200')
  }, 300_000)
})
