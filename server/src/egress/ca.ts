// ─────────────────────────────────────────────────────────────────────────────
// Routini's egress CA: a private certificate authority sandboxed containers
// trust, used only to intercept hosts that have credential bindings.
//
// Keys come from Node's native crypto (fast); certificates are built with
// node-forge. One leaf key is shared by all leaf certificates (standard for
// intercepting proxies); leaves are cached per host. With a directory, the CA
// persists across restarts so long-lived environments keep trusting it.
// ─────────────────────────────────────────────────────────────────────────────

import forge from 'node-forge'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSecureContext, type SecureContext } from 'node:tls'

export interface CaMaterial {
  certPem: string
  keyPem: string
}

function rsaPem(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

const serial = () => '01' + randomBytes(15).toString('hex')

export function generateCa(commonName = 'Routini Egress CA'): CaMaterial {
  const keys = rsaPem()
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem)
  cert.serialNumber = serial()
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600_000)
  const attrs = [{ name: 'commonName', value: commonName }, { name: 'organizationName', value: 'Routini' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(forge.pki.privateKeyFromPem(keys.privatePem), forge.md.sha256.create())
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem }
}

/** Loads the CA from `dir` (creating and saving one if absent), or makes an ephemeral one. */
export function loadOrCreateCa(dir?: string): CaMaterial {
  if (!dir) return generateCa()
  const certPath = join(dir, 'ca.pem')
  const keyPath = join(dir, 'ca-key.pem')
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8') }
  }
  mkdirSync(dir, { recursive: true })
  const ca = generateCa()
  writeFileSync(keyPath, ca.keyPem, { mode: 0o600 })
  writeFileSync(certPath, ca.certPem, { mode: 0o644 })
  return ca
}

export class LeafIssuer {
  private readonly caCert: forge.pki.Certificate
  private readonly caKey: forge.pki.rsa.PrivateKey
  private readonly leaf = rsaPem()
  private readonly cache = new Map<string, SecureContext>()

  constructor(readonly ca: CaMaterial) {
    this.caCert = forge.pki.certificateFromPem(ca.certPem)
    this.caKey = forge.pki.privateKeyFromPem(ca.keyPem) as forge.pki.rsa.PrivateKey
  }

  /** TLS context presenting a certificate for `host`, signed by the CA. */
  contextFor(host: string): SecureContext {
    let ctx = this.cache.get(host)
    if (ctx) return ctx
    const pem = this.pemFor(host)
    ctx = createSecureContext({ key: pem.keyPem, cert: pem.certPem + this.ca.certPem })
    this.cache.set(host, ctx)
    return ctx
  }

  /** Leaf certificate and key for `host` as PEM (also used by tests to stand up servers). */
  pemFor(host: string): { certPem: string; keyPem: string } {
    const cert = forge.pki.createCertificate()
    cert.publicKey = forge.pki.publicKeyFromPem(this.leaf.publicPem)
    cert.serialNumber = serial()
    cert.validity.notBefore = new Date(Date.now() - 60_000)
    cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000)
    cert.setSubject([{ name: 'commonName', value: host }])
    cert.setIssuer(this.caCert.subject.attributes)
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [isIp ? { type: 7, ip: host } : { type: 2, value: host }] },
    ])
    cert.sign(this.caKey, forge.md.sha256.create())
    return { certPem: forge.pki.certificateToPem(cert), keyPem: this.leaf.privatePem }
  }
}
