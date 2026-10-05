// ─────────────────────────────────────────────────────────────────────────────
// Environments
//
//   GET    /api/orgs/:org/environments
//   POST   /api/orgs/:org/environments              create (async; 202)       (member)
//   GET    /api/orgs/:org/environments/:id          + recent events
//   PUT    /api/orgs/:org/environments/:id          name, idleMinutes          (member)
//   POST   /api/orgs/:org/environments/:id/start                               (member)
//   POST   /api/orgs/:org/environments/:id/stop                                (member)
//   DELETE /api/orgs/:org/environments/:id          removes container + volume (admin)
//   POST   /api/orgs/:org/environments/:id/exec     one-shot command           (admin)
//   WS     /api/orgs/:org/environments/:id/terminal (see http/terminal.ts)
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { ah, badRequest, currentOrg, currentUser, HttpError, notFound, type AppContext } from '../http/common.js'
import { requireRole } from '../http/orgContext.js'
import {
  addEnvironmentEvent,
  getEnvironment,
  insertEnvironment,
  listEnvironmentEvents,
  listEnvironments,
  updateEnvironmentSettings,
  type Environment,
} from '../repos/environments.js'
import { EnvError, repoDirName } from '../engine/environments.js'
import { defaultAgentImages } from '../engine/agent.js'
import { validateRepoUrl } from '../utils/repoUrl.js'
import { redact } from '../utils/redact.js'

const MAX_EXEC_OUTPUT = 64 * 1024
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505'

/** Images environments may use. Hosted: the configured agent images only. Self-host: any image. */
export function allowedImages(mode: 'selfhost' | 'hosted', env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (mode === 'selfhost') return null
  const configured = (env['ROUTINI_ENV_IMAGES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return configured.length ? configured : Object.values(defaultAgentImages(env)).filter((v): v is string => Boolean(v))
}

export function environmentsRouter(ctx: AppContext): Router {
  const r = Router({ mergeParams: true })
  const { db, envs } = ctx

  const wrapEnvError = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof EnvError) throw new HttpError(err.status, err.message)
      throw err
    }
  }

  const view = (e: Environment) => ({
    ...e,
    containerId: undefined,
    volume: undefined,
    // Self-hosters can attach their own tools (VS Code Dev Containers, a shell).
    ...(ctx.config.mode === 'selfhost' && e.status === 'running' && e.containerId
      ? { attachCommand: `docker exec -it -u 1000 -w /workspace ${e.containerId.slice(0, 12)} bash -l` }
      : {}),
  })

  const idOr404 = (raw: unknown) => {
    const id = String(raw)
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Environment not found')
    return id
  }

  r.get(
    '/environments',
    ah(async (req, res) => {
      const org = currentOrg(req)
      res.json({ environments: (await db.org(org.id, (q) => listEnvironments(q, org.id))).map(view) })
    }),
  )

  r.post(
    '/environments',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const user = currentUser(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const name = typeof b['name'] === 'string' ? b['name'].trim() : ''
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) throw badRequest('name must be 1–63 chars of letters, digits, ".", "_" or "-"')

      const image = typeof b['image'] === 'string' && b['image'].trim() ? b['image'].trim() : defaultAgentImages().claude!
      if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/.test(image)) throw badRequest('image is not a valid image reference')
      const allowed = allowedImages(ctx.config.mode)
      if (allowed && !allowed.includes(image)) throw badRequest(`image must be one of: ${allowed.join(', ')}`)

      let repo: Environment['repo'] = null
      if (b['repo'] !== undefined && b['repo'] !== null) {
        const raw = b['repo'] as Record<string, unknown>
        const url = typeof raw?.['url'] === 'string' ? raw['url'].trim() : ''
        const check = validateRepoUrl(url)
        if (!check.valid) throw badRequest(`repo.url: ${check.error}`)
        const branch = typeof raw['branch'] === 'string' && raw['branch'].trim() ? raw['branch'].trim() : 'main'
        if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.includes('..')) throw badRequest('repo.branch is not a valid branch name')
        repo = { url, branch, dir: repoDirName(url) }
      }
      const num = (k: string, min: number, max: number, dflt: number) => {
        const v = b[k]
        if (v === undefined) return dflt
        if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw badRequest(`${k} must be a number between ${min} and ${max}`)
        return v
      }
      const id = randomUUID()
      let env: Environment
      try {
        env = await db.org(org.id, (q) =>
          insertEnvironment(q, {
            orgId: org.id,
            name,
            image,
            repo,
            volume: `routini-env-${id}`,
            cpus: num('cpus', 0.5, 8, 2),
            memoryMb: Math.round(num('memoryMb', 512, 16_384, 4096)),
            idleMinutes: Math.round(num('idleMinutes', 5, 10_080, 60)),
            createdBy: user.id,
          }),
        )
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, `An environment named "${name}" already exists`)
        throw err
      }
      try {
        await envs.provision(env, user.id)
      } catch (err) {
        await db.org(org.id, (q) => q.query('DELETE FROM environments WHERE org_id = $1 AND id = $2', [org.id, env.id]))
        if (err instanceof EnvError) throw new HttpError(err.status, err.message)
        throw err
      }
      res.status(202).json({ environment: view(env) })
    }),
  )

  r.get(
    '/environments/:id',
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      const out = await db.org(org.id, async (q) => {
        const env = await getEnvironment(q, org.id, id)
        if (!env) throw notFound('Environment not found')
        return { environment: view(env), events: await listEnvironmentEvents(q, org.id, id, 30) }
      })
      res.json(out)
    }),
  )

  r.put(
    '/environments/:id',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      const b = (req.body ?? {}) as Record<string, unknown>
      const patch: { name?: string; idleMinutes?: number } = {}
      if (b['name'] !== undefined) {
        if (typeof b['name'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(b['name'])) throw badRequest('name is not valid')
        patch.name = b['name']
      }
      if (b['idleMinutes'] !== undefined) {
        if (!Number.isInteger(b['idleMinutes']) || (b['idleMinutes'] as number) < 5 || (b['idleMinutes'] as number) > 10_080) {
          throw badRequest('idleMinutes must be a whole number between 5 and 10080')
        }
        patch.idleMinutes = b['idleMinutes'] as number
      }
      try {
        const env = await db.org(org.id, (q) => updateEnvironmentSettings(q, org.id, id, patch))
        if (!env) throw notFound('Environment not found')
        res.json({ environment: view(env) })
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Another environment already has that name')
        throw err
      }
    }),
  )

  r.post(
    '/environments/:id/start',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const env = await wrapEnvError(() => envs.start(org.id, idOr404(req.params['id']), currentUser(req).id))
      res.status(202).json({ environment: view(env) })
    }),
  )

  r.post(
    '/environments/:id/stop',
    requireRole('member'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const env = await wrapEnvError(() => envs.stop(org.id, idOr404(req.params['id']), currentUser(req).id))
      res.json({ environment: view(env) })
    }),
  )

  r.delete(
    '/environments/:id',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      await wrapEnvError(() => envs.destroy(org.id, idOr404(req.params['id']), currentUser(req).id))
      res.status(204).end()
    }),
  )

  r.post(
    '/environments/:id/exec',
    requireRole('admin'),
    ah(async (req, res) => {
      const org = currentOrg(req)
      const id = idOr404(req.params['id'])
      const command = (req.body ?? {})['command']
      if (typeof command !== 'string' || !command.trim() || command.length > 8000) throw badRequest('command must be a non-empty string')
      const env = await wrapEnvError(() => envs.ensureRunning(org.id, id))
      let output = ''
      let truncated = false
      const r2 = await envs.runtime.exec(env.containerId!, ['bash', '-lc', command], {
        timeoutMs: 60_000,
        onLine: (l) => {
          if (output.length + l.length + 1 > MAX_EXEC_OUTPUT) truncated = true
          else output += `${l}\n`
        },
      })
      await db.org(org.id, async (q) => {
        await addEnvironmentEvent(q, org.id, id, 'exec', currentUser(req).id, { command: redact(command).slice(0, 500), exitCode: r2.exitCode })
      })
      await envs.touch(org.id, id)
      res.json({ exitCode: r2.exitCode, timedOut: r2.timedOut, output: redact(output), truncated })
    }),
  )

  return r
}
