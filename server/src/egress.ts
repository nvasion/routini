// Egress proxy entry point (`node dist/egress.js`). Runs as its own container,
// attached to each org's sandbox network by the broker client.

import { loadOrCreateCa } from './egress/ca.js'
import { EgressProxy } from './egress/proxy.js'

const secret = process.env['ROUTINI_EGRESS_SECRET']?.trim()
if (!secret || secret.length < 16) {
  console.error('[egress] ROUTINI_EGRESS_SECRET (at least 16 characters) is required')
  process.exit(1)
}
const ca = loadOrCreateCa(process.env['ROUTINI_EGRESS_CA_DIR']?.trim() || undefined)
const proxy = new EgressProxy({ secret, ca })
const ports = await proxy.listen(Number(process.env['ROUTINI_EGRESS_PROXY_PORT'] ?? 3128), Number(process.env['ROUTINI_EGRESS_CONTROL_PORT'] ?? 3129))
console.log(`[egress] proxy on :${ports.proxyPort}, control on :${ports.controlPort}`)

const shutdown = () => void proxy.close().finally(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
