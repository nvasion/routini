// ─────────────────────────────────────────────────────────────────────────────
// Hosts (server inventory; feeds the console's Servers dock)
//
//   GET    /api/orgs/:org/hosts
//   POST   /api/orgs/:org/hosts                 (admin)
//   GET    /api/orgs/:org/hosts/:id
//   PUT    /api/orgs/:org/hosts/:id             (admin)
//   DELETE /api/orgs/:org/hosts/:id             (admin; refused while a job's command step uses it; revokes its runner)
//   POST   /api/orgs/:org/hosts/:id/check       status: SSH probe, or the runner's latest facts (member)
//   GET    /api/orgs/:org/hosts/:id/events      audit trail (terminal sessions, runner connects)
//
// Runner hosts are created by enrollment (routes/runners.ts); only their name,
// group and tags are editable.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { ah, badRequest, currentOrg, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import {
  createHost,
  deleteHost,
  getHost,
  HOST_CHECK_COMMAND,
  HostInputError,
  listHostEvents,
  listHosts,
  parseRunnerHostInput,
  updateRunnerHost,
  parseHostCheck,
  parseHostInput,
  recordHostCheck,
  updateHost,
  type HostCheck,
  type HostInput,
} from '../repos/hosts.js'
import { getSecret } from '../repos/credentials.js'
import { runSshTask } from '../services/ssh.js'
import { revokeRunner } from '../repos/runners.js'
import { redact } from '../utils/redact.js'

function parseOr400(raw: unknown, current?: HostInput): HostInput {
  try {
    return parseHostInput(raw, current)
  } catch (err) {
    if (err instanceof HostInputError) throw badRequest(err.message)
    throw err
  }
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505'

export function hostsRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })
  const db = ctx.db
  const idOr404 = (raw: unknown) => {
    const id = String(raw)
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Host not found')
    return id
  }

  r.get(
    '/hosts',
    ah(async (req, res) => {
      const org = currentOrg(req)
      res.json({ hosts: await db.org(org.id, (q) => listHosts(q, org.id)) })
    }),
  )

  r.post(
    '/hosts',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const input = parseOr400(req.body)
      try {
        res.status(201).json({ host: await db.org(org.id, (q) => createHost(q, org.id, input)) })
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, `A host named "${input.name}" already exists`)
        throw err
      }
    }),
  )

  r.get(
    '/hosts/:id',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const host = await db.org(org.id, (q) => getHost(q, org.id, idOr404(req.params['id'])))
      if (!host) throw notFound('Host not found')
      res.json({ host })
    }),
  )

  r.put(
    '/hosts/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      try {
        const host = await db.org(org.id, async (q) => {
          const current = await getHost(q, org.id, id)
          if (!current) throw notFound('Host not found')
          if (current.transport === 'runner') {
            try {
              return updateRunnerHost(q, org.id, id, parseRunnerHostInput(req.body, current))
            } catch (err) {
              if (err instanceof HostInputError) throw badRequest(err.message)
              throw err
            }
          }
          return updateHost(q, org.id, id, parseOr400(req.body, { ...current, username: current.username ?? '' }))
        })
        res.json({ host })
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Another host already has that name')
        throw err
      }
    }),
  )

  r.delete(
    '/hosts/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      const runnerId = await db.org(org.id, async (q) => {
        const users = await q.query<{ name: string }>(
          `SELECT name FROM jobs WHERE org_id = $1 AND archived_at IS NULL
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(steps) s WHERE s->'config'->>'hostId' = $2)`,
          [org.id, id],
        )
        if (users.length) throw new HttpError(409, `Host is used by: ${users.map((u) => u.name).join(', ')}`)
        const host = await getHost(q, org.id, id)
        if (!host) throw notFound('Host not found')
        const active = host.runner && !host.runner.revoked ? host.runner.id : null
        if (active) await revokeRunner(q, org.id, active)
        await deleteHost(q, org.id, id)
        return active
      })
      if (runnerId) await ctx.runners.revoke(runnerId)
      res.status(204).end()
    }),
  )

  r.post(
    '/hosts/:id/check',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      const { host, secret, passphrase } = await db.org(org.id, async (q) => {
        const host = await getHost(q, org.id, id)
        if (!host) throw notFound('Host not found')
        const secret = host.credentialKey ? await getSecret(q, ctx.box, org.id, host.credentialKey) : null
        const passphrase = host.credentialKey && host.auth === 'key' ? await getSecret(q, ctx.box, org.id, `${host.credentialKey}.passphrase`) : null
        return { host, secret, passphrase }
      })

      let check: HostCheck
      if (host.transport === 'runner') {
        // Runners report facts every minute; the check is their latest report.
        check =
          host.runner?.online && host.lastCheck
            ? host.lastCheck
            : { ok: false, at: new Date().toISOString(), error: host.runner?.revoked ? 'The runner was removed' : 'The runner is offline' }
        return void res.json({ check })
      }
      if (!secret || !host.username) {
        check = { ok: false, at: new Date().toISOString(), error: host.credentialKey ? `Credential "${host.credentialKey}" is missing` : 'No credential configured' }
      } else {
        const result = await runSshTask(
          { id: host.id, config: { host: host.address, port: String(host.port), username: host.username, command: HOST_CHECK_COMMAND } },
          {
            allowPrivateHosts: ctx.config.mode === 'selfhost',
            allowShellSyntax: true,
            executor: ctx.actions?.sshExecutor,
            credentialProvider: {
              async get(name) {
                if (name === 'SSH_PRIVATE_KEY') return host.auth === 'key' ? secret : undefined
                if (name === 'SSH_PASSWORD') return host.auth === 'password' ? secret : undefined
                if (name === 'SSH_KEY_PASSPHRASE') return passphrase ?? undefined
                return undefined
              },
            },
          },
        )
        const stdout = result.logs
          .filter((l) => l.startsWith('[stdout] '))
          .map((l) => l.slice('[stdout] '.length))
          .join('\n')
        check = result.success
          ? { ok: true, at: new Date().toISOString(), ...parseHostCheck(stdout) }
          : { ok: false, at: new Date().toISOString(), error: redact(result.error ?? 'Check failed', [secret]) }
      }
      await db.org(org.id, (q) => recordHostCheck(q, org.id, host.id, check))
      res.json({ check })
    }),
  )

  r.get(
    '/hosts/:id/events',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      const events = await db.org(org.id, async (q) => {
        if (!(await getHost(q, org.id, id))) throw notFound('Host not found')
        return listHostEvents(q, org.id, id)
      })
      res.json({ events })
    }),
  )

  return r
}
