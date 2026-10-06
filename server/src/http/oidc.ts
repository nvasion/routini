// ─────────────────────────────────────────────────────────────────────────────
// Sign in with TynHub (or any OIDC provider): Authorization Code + PKCE.
//
//   GET /api/auth/providers            { oidc: { name } | null, signupOpen, mail, emailVerification }  (login page, console)
//   GET /api/auth/oidc/start?next=…    → the provider            (&link=1: link to the signed-in account)
//   GET /api/auth/oidc/callback        ← the provider → console
//
// Account rules (TynHub DESIGN-tynhub-network-sso):
//   – A returning identity (issuer + sub) signs in its user.
//   – A new identity never attaches itself to an existing account by email:
//     Routini does not verify local emails, so that would let someone who
//     pre-registered a victim's address capture their sign-in. Those users sign
//     in with their password and link TynHub from their account (link=1).
//   – Otherwise a new account is created when signup allows it, or when the
//     user belongs to a TynHub org an admin has linked to a Routini org.
//   – `orgs` claim ([{ slug, role }]): the user joins Routini orgs linked to
//     those TynHub orgs (TynHub owner/admin → admin, else member). Existing
//     memberships are never changed and nobody is removed automatically.
//
// State, nonce, PKCE verifier and `next` travel in a short-lived signed cookie
// (SameSite=Lax: the callback is a cross-site navigation).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import * as oidc from 'openid-client'
import type { AppContext } from './common.js'
import type { Auth } from './auth.js'
import { addIdentity, countUsers, createOrg, createUser, findUserByIdentity, listIdentities, orgsLinkedToTynhub, type Role } from '../repos/identity.js'

const STATE_COOKIE = 'routini_oidc'
const STATE_TTL_SEC = 600

export interface OidcClaims {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  orgs?: unknown
}

export class OidcError extends Error {}

/** TynHub org role → Routini role for a new membership. */
export function mapTynhubRole(role: unknown): Role {
  return role === 'owner' || role === 'admin' ? 'admin' : 'member'
}

export function parseOrgsClaim(raw: unknown): Array<{ slug: string; role: unknown }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((o): o is { slug: string; role?: unknown } => !!o && typeof o === 'object' && typeof (o as { slug?: unknown }).slug === 'string')
    .map((o) => ({ slug: o.slug.toLowerCase(), role: o.role }))
}

/**
 * The configured scopes the provider supports. Strict providers (Dex, Google)
 * reject unknown scopes such as TynHub's `orgs`; providers that don't publish
 * `scopes_supported` get the configured list as is.
 */
export function requestedScopes(configured: string, supported: string[] | undefined): string {
  const wanted = configured.split(/\s+/).filter(Boolean)
  if (!supported?.length) return wanted.join(' ')
  return wanted.filter((s) => s === 'openid' || supported.includes(s)).join(' ')
}

/** Only same-origin console paths are allowed as `next` (no open redirects). */
export function safeNext(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  return /^\/(?!\/)[A-Za-z0-9/_\-.?=&%]*$/.test(s) && !s.includes('\\') ? s : '/'
}

/**
 * Finds or creates the user for verified claims and syncs TynHub org
 * memberships. `linkUserId` attaches the identity to that (signed-in) user.
 */
export async function signInWithClaims(
  ctx: AppContext,
  provider: string,
  claims: OidcClaims,
  linkUserId: string | null,
): Promise<{ userId: string; created: boolean; joined: string[] }> {
  const tynhubOrgs = parseOrgsClaim(claims.orgs)
  return ctx.db.tx(async (q) => {
    const existing = await findUserByIdentity(q, provider, claims.sub)
    let userId: string
    let created = false

    if (linkUserId) {
      if (existing && existing.id !== linkUserId) throw new OidcError('That account is already linked to another Routini user')
      await addIdentity(q, linkUserId, provider, claims.sub)
      userId = linkUserId
    } else if (existing) {
      userId = existing.id
    } else {
      const email = (claims.email ?? '').trim().toLowerCase()
      if (!email || claims.email_verified !== true) throw new OidcError('Your account needs a verified email address to sign in to Routini')
      const [taken] = await q.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email])
      if (taken) throw new OidcError('An account with this email already exists: sign in with your password, then link it from your account menu')
      const linkedOrgs = await orgsLinkedToTynhub(q, tynhubOrgs.map((o) => o.slug))
      const signupOpen = ctx.config.signup === 'open' || (ctx.config.signup === 'first-user-only' && (await countUsers(q)) === 0)
      if (!signupOpen && linkedOrgs.length === 0) throw new OidcError('Signup is closed on this server; ask an admin to link your TynHub org')
      const displayName = (claims.name ?? claims.preferred_username ?? '').slice(0, 100)
      const user = await createUser(q, { email, passwordHash: null, displayName, emailVerified: true })
      await addIdentity(q, user.id, provider, claims.sub)
      userId = user.id
      created = true
      // A personal org only when they are not joining a linked one.
      if (linkedOrgs.length === 0) {
        const org = await createOrg(q, { name: displayName || email.split('@')[0]!, slugBase: email.split('@')[0]!, plan: ctx.config.mode === 'hosted' ? 'free' : 'selfhost' })
        await q.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [org.id, user.id])
      }
    }

    // A provider that verified this same address verifies it for Routini too.
    if (!created && claims.email_verified === true && claims.email) {
      await q.query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1 AND lower(email) = lower($2)', [userId, claims.email.trim()])
    }

    // Join linked orgs (never change or remove existing memberships).
    const joined: string[] = []
    for (const org of await orgsLinkedToTynhub(q, tynhubOrgs.map((o) => o.slug))) {
      const role = mapTynhubRole(tynhubOrgs.find((o) => o.slug === org.tynhubOrg)?.role)
      const rows = await q.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING RETURNING org_id`, [org.id, userId, role])
      if (rows.length) joined.push(org.slug)
    }
    return { userId, created, joined }
  })
}

export function oidcRouter(ctx: AppContext, auth: Auth): Router {
  const r = Router()
  const cfg = ctx.config.oidc
  const provider = cfg ? `oidc:${cfg.issuer}` : ''
  const redirectUri = `${ctx.config.publicUrl}/api/auth/oidc/callback`
  const secure = ctx.config.env === 'production'
  let discovered: Promise<oidc.Configuration> | null = null

  const configuration = (): Promise<oidc.Configuration> => {
    if (!cfg) throw new OidcError('Sign-in with an identity provider is not configured')
    discovered ??= oidc
      .discovery(new URL(cfg.issuer), cfg.clientId, undefined, oidc.ClientSecretBasic(cfg.clientSecret), {
        // Plain-http issuers only for local development and labs.
        ...(cfg.issuer.startsWith('http://') ? { execute: [oidc.allowInsecureRequests] } : {}),
      })
      .catch((err) => {
        discovered = null // retry on the next sign-in
        throw err
      })
    return discovered
  }

  const toLogin = (res: Response, message: string) => res.redirect(302, `${ctx.config.clientUrl}/login?error=${encodeURIComponent(message)}`)

  // What the login and landing pages offer: an identity provider, and whether
  // email signup is open (open, or first-user-only on a server with no users yet).
  r.get('/providers', (_req, res) => {
    // Whether account emails go out (password reset needs it).
    const mail = ctx.mailer !== undefined ? ctx.mailer !== null : Boolean(process.env['SMTP_HOST']?.trim())
    void (async () => {
      const signup = ctx.config.signup
      const signupOpen = signup === 'open' || (signup === 'first-user-only' && (await countUsers(ctx.db)) === 0)
      res.json({ oidc: cfg ? { name: cfg.name } : null, signupOpen, mail, emailVerification: ctx.config.requireVerifiedEmail })
    })().catch(() => res.json({ oidc: cfg ? { name: cfg.name } : null, signupOpen: false, mail, emailVerification: ctx.config.requireVerifiedEmail }))
  })

  r.get('/oidc/start', (req: Request, res: Response) => {
    void (async () => {
      let linkUserId: string | null = null
      if (req.query['link'] === '1') {
        const session = await auth.authenticate(req.headers)
        if (!session || session.apiToken) return toLogin(res, 'Sign in first, then link your account')
        linkUserId = session.user.id
      }
      const config = await configuration()
      const verifier = oidc.randomPKCECodeVerifier()
      const state = oidc.randomState()
      const nonce = oidc.randomNonce()
      const cookie = jwt.sign({ v: verifier, s: state, n: nonce, next: safeNext(req.query['next']), link: linkUserId }, ctx.config.jwtSecret, { expiresIn: STATE_TTL_SEC })
      res.cookie(STATE_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure, maxAge: STATE_TTL_SEC * 1000, path: '/api/auth/oidc' })
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: requestedScopes(cfg!.scopes, config.serverMetadata().scopes_supported),
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      res.redirect(302, url.href)
    })().catch((err) => {
      console.error('[oidc] start failed:', (err as Error).message)
      toLogin(res, err instanceof OidcError ? err.message : 'The identity provider is unavailable')
    })
  })

  r.get('/oidc/callback', (req: Request, res: Response) => {
    void (async () => {
      const raw = req.cookies?.[STATE_COOKIE] as string | undefined
      res.clearCookie(STATE_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/api/auth/oidc' })
      let st: { v: string; s: string; n: string; next: string; link: string | null }
      try {
        st = jwt.verify(raw ?? '', ctx.config.jwtSecret) as typeof st
      } catch {
        return toLogin(res, 'The sign-in took too long or was started elsewhere; try again')
      }
      if (typeof req.query['error'] === 'string') return toLogin(res, `The identity provider said: ${String(req.query['error_description'] ?? req.query['error'])}`)
      const config = await configuration()
      // Validate against the exact registered redirect URI, not whatever host the request came through.
      const current = new URL(redirectUri)
      current.search = new URL(req.originalUrl, 'http://localhost').search
      let tokens
      try {
        tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: st.v, expectedState: st.s, expectedNonce: st.n, idTokenExpected: true })
      } catch (err) {
        console.error('[oidc] code exchange failed:', (err as Error).message)
        return toLogin(res, 'Sign-in could not be verified; try again')
      }
      let claims = tokens.claims() as OidcClaims | undefined
      if (!claims?.sub) return toLogin(res, 'The identity provider did not identify you')
      // Profile claims may live only in userinfo.
      if (claims.email === undefined || claims.orgs === undefined) {
        try {
          const info = (await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)) as OidcClaims
          claims = { ...info, ...claims, orgs: claims.orgs ?? info.orgs, email: claims.email ?? info.email, email_verified: claims.email_verified ?? info.email_verified }
        } catch {
          // userinfo is optional
        }
      }
      let result
      try {
        result = await signInWithClaims(ctx, provider, claims, st.link)
      } catch (err) {
        if (err instanceof OidcError) return toLogin(res, err.message)
        throw err
      }
      auth.issueSession(res, result.userId)
      res.redirect(302, `${ctx.config.clientUrl}${st.link ? '/?linked=1' : st.next}`)
    })().catch((err) => {
      console.error('[oidc] callback failed:', (err as Error).message)
      toLogin(res, 'Sign-in failed; try again')
    })
  })

  return r
}

/** GET /api/auth/identities: the signed-in user's linked sign-in providers (account menu). */
export function identitiesRouter(ctx: AppContext, auth: Auth): Router {
  const r = Router()
  r.get('/identities', auth.requireAuth, (req: Request, res: Response) => {
    void listIdentities(ctx.db, req.user!.id)
      .then((ids) => {
        const issuer = ctx.config.oidc ? `oidc:${ctx.config.oidc.issuer}` : null
        res.json({ provider: ctx.config.oidc ? { name: ctx.config.oidc.name, linked: ids.some((i) => i.provider === issuer) } : null })
      })
      .catch(() => res.status(500).json({ error: 'Could not load identities' }))
  })
  return r
}
