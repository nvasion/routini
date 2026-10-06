// ─────────────────────────────────────────────────────────────────────────────
// Account basics for open signup: password reset, email verification, and
// deleting an account.
//
//   POST   /api/auth/password/forgot  { email }             same answer whether or not it exists
//   POST   /api/auth/password/reset   { token, password }   then every session is revoked
//   POST   /api/auth/email/verify     { token }
//   POST   /api/auth/email/resend     (session)
//   DELETE /api/auth/account          (session) { password | confirmEmail, deleteOrgs }
//
// Links carry single-use tokens (repos/authTokens.ts): 30 minutes for a reset,
// a day for verification (http/accountMail.ts sends them). Emails are
// rate-limited per IP and per account.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { ah, badRequest, currentUser, HttpError, type AppContext } from './common.js'
import { MAX_PASSWORD, MIN_PASSWORD, type Auth } from './auth.js'
import { countRecentAuthTokens, consumeAuthToken, invalidateAuthTokens } from '../repos/authTokens.js'
import {
  countOwners,
  deleteOrg,
  deleteUser,
  findUserByEmail,
  findUserById,
  listMembers,
  listOrgsForUser,
  markEmailVerified,
  revokeSessions,
  setPasswordHash,
  type Org,
} from '../repos/identity.js'
import { listEnvironments } from '../repos/environments.js'
import { accountMail } from './accountMail.js'

/** Emails of one kind an account may trigger per hour. */
const EMAILS_PER_HOUR = 3

const FORGOT_REPLY = { message: 'If an account exists for that email, we sent a link to reset its password.' }

export function accountRouter(ctx: AppContext, auth: Auth): Router {
  const { db, config } = ctx
  const rounds = config.env === 'test' ? 1 : 10
  const router = Router()

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later' },
    skip: () => config.env === 'test',
  })

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const mail = accountMail(ctx)

  router.post(
    '/password/forgot',
    limiter,
    ah(async (req, res) => {
      const email = str(req.body?.email).trim()
      if (!email) throw badRequest('Email is required')
      const user = await findUserByEmail(db, email)
      if (user && (await countRecentAuthTokens(db, user.id, 'reset', 60)) < EMAILS_PER_HOUR) {
        // Not awaited: a slow mail server must not reveal that the account exists.
        void mail.sendReset(user.id, user.email).catch((err) => console.error('[account] reset email failed:', (err as Error).message))
      }
      res.json(FORGOT_REPLY)
    }),
  )

  router.post(
    '/password/reset',
    limiter,
    ah(async (req, res) => {
      const token = str(req.body?.token)
      const password = str(req.body?.password)
      if (!token) throw badRequest('Reset token is required')
      if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
        throw badRequest(`Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters`)
      }
      const hash = await bcrypt.hash(password, rounds)
      const userId = await db.tx(async (q) => {
        const id = await consumeAuthToken(q, token, 'reset')
        if (!id) return null
        await setPasswordHash(q, id, hash)
        await invalidateAuthTokens(q, id, 'reset')
        await revokeSessions(q, id)
        // The link reached their inbox, which proves the address too.
        await markEmailVerified(q, id)
        return id
      })
      if (!userId) throw new HttpError(400, 'This reset link is invalid or has expired')
      auth.clearSession(res)
      res.json({ message: 'Password changed. Sign in with your new password.' })
    }),
  )

  router.post(
    '/email/verify',
    limiter,
    ah(async (req, res) => {
      const token = str(req.body?.token)
      if (!token) throw badRequest('Verification token is required')
      const userId = await db.tx(async (q) => {
        const id = await consumeAuthToken(q, token, 'verify')
        if (id) await markEmailVerified(q, id)
        return id
      })
      if (!userId) throw new HttpError(400, 'This verification link is invalid or has expired')
      res.json({ message: 'Email verified' })
    }),
  )

  router.post(
    '/email/resend',
    limiter,
    auth.requireAuth,
    auth.requireCsrf,
    ah(async (req, res) => {
      const user = currentUser(req)
      if (user.emailVerified) {
        res.json({ message: 'Your email is already verified' })
        return
      }
      if ((await countRecentAuthTokens(db, user.id, 'verify', 60)) >= EMAILS_PER_HOUR) {
        throw new HttpError(429, 'We sent several verification emails in the last hour; check your inbox and spam folder')
      }
      if (!(await mail.sendVerification(user.id, user.email)) && config.env === 'production') {
        throw new HttpError(503, 'Email is not configured on this server yet')
      }
      res.json({ message: `Verification email sent to ${user.email}` })
    }),
  )

  router.delete(
    '/account',
    auth.requireAuth,
    auth.requireCsrf,
    ah(async (req, res) => {
      if (req.apiToken) throw new HttpError(403, 'Delete your account from the console, not with an API token')
      const user = await findUserById(db, currentUser(req).id)
      if (!user) throw new HttpError(404, 'Account not found')
      if (user.passwordHash) {
        if (!(await bcrypt.compare(str(req.body?.password), user.passwordHash))) throw new HttpError(403, 'Password is incorrect')
      } else if (str(req.body?.confirmEmail).trim().toLowerCase() !== user.email.toLowerCase()) {
        throw badRequest('Type your email address to confirm')
      }

      // Orgs only this user owns: deleted with the account when they're the only
      // member, otherwise ownership has to move first.
      const toDelete: Org[] = []
      const needNewOwner: Org[] = []
      for (const { org, role } of await listOrgsForUser(db, user.id)) {
        if (role !== 'owner' || (await countOwners(db, org.id)) > 1) continue
        ;((await listMembers(db, org.id)).length > 1 ? needNewOwner : toDelete).push(org)
      }
      const brief = (orgs: Org[]) => orgs.map((o) => ({ slug: o.slug, name: o.name }))
      if (needNewOwner.length) {
        res.status(409).json({ error: 'Make someone else an owner of these orgs first, or remove their other members', code: 'transfer_ownership', orgs: brief(needNewOwner) })
        return
      }
      if (toDelete.length && req.body?.deleteOrgs !== true) {
        res.status(409).json({ error: 'Deleting your account also deletes these orgs and everything in them', code: 'confirm_org_deletion', orgs: brief(toDelete) })
        return
      }
      for (const org of toDelete) {
        const [active] = await db.org(org.id, (q) =>
          q.query<{ n: string | number }>(`SELECT count(*) AS n FROM runs WHERE org_id = $1 AND status IN ('queued', 'running', 'waiting')`, [org.id]),
        )
        if (Number(active?.n ?? 0) > 0) throw new HttpError(409, `Cancel or wait for the runs in progress in ${org.name} first`)
      }

      for (const org of toDelete) {
        // Containers and volumes on the Docker host first; if that fails, nothing is deleted yet.
        for (const env of await db.org(org.id, (q) => listEnvironments(q, org.id))) {
          try {
            await ctx.envs.destroy(org.id, env.id, user.id)
          } catch (err) {
            console.error(`[account] removing environment ${env.id} failed:`, (err as Error).message)
            throw new HttpError(503, 'Could not remove your environments right now; try again in a few minutes')
          }
        }
        await deleteOrg(db, org.id)
      }
      await deleteUser(db, user.id)
      auth.clearSession(res)
      res.json({ message: 'Account deleted', deletedOrgs: toDelete.map((o) => o.slug) })
    }),
  )

  return router
}
