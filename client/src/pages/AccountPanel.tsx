// Your account (not the org's): email verification and deleting the account.
// Also the console banner that asks unverified users to verify.

import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBanner, Field, Modal } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useApi } from '../lib/hooks'

interface Providers {
  mail?: boolean
  emailVerification?: boolean
}

function useResend() {
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const resend = async () => {
    setBusy(true)
    setError(null)
    try {
      setNote((await api<{ message: string }>('/api/auth/email/resend', { method: 'POST' })).message)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { note, error, busy, resend }
}

/** Shown in the console while this server gates agents on a verified email and yours isn't. */
export function VerifyEmailBanner() {
  const { session } = useAuth()
  const providers = useApi<Providers>('/api/auth/providers')
  const r = useResend()
  if (!session || session.user.emailVerified !== false || !providers.data?.emailVerification) return null
  return (
    <div className="banner info" role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
      <span style={{ flex: '1 1 260px' }}>
        {r.note ?? `Verify ${session.user.email} to run agent steps and start environments. Check your inbox for the link.`}
      </span>
      {r.error && <span style={{ color: 'var(--fail)' }}>{r.error}</span>}
      {!r.note && (
        <button type="button" className="btn" disabled={r.busy} onClick={() => void r.resend()}>
          {r.busy ? 'Sending…' : 'Resend email'}
        </button>
      )}
    </div>
  )
}

export function AccountPanel() {
  const { session } = useAuth()
  const providers = useApi<Providers>('/api/auth/providers')
  const r = useResend()
  const [deleting, setDeleting] = useState(false)
  if (!session) return null
  const user = session.user

  return (
    <div className="stack" style={{ gap: 16 }}>
      <section className="card stack">
        <h2 style={{ margin: 0 }}>Email</h2>
        <p style={{ margin: 0 }}>
          <span className="mono">{user.email}</span>{' '}
          {user.emailVerified === false ? <span className="badge">not verified</span> : user.emailVerified ? <span className="badge accent">verified</span> : null}
        </p>
        {user.emailVerified === false && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {providers.data?.emailVerification
                ? 'This server needs a verified email before you can run agent steps or start environments.'
                : 'Verifying lets you reset your password by email.'}
            </p>
            {providers.data?.mail === false ? (
              <p className="muted" style={{ margin: 0 }}>
                This server doesn't send email yet.
              </p>
            ) : (
              <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} disabled={r.busy} onClick={() => void r.resend()}>
                {r.busy ? 'Sending…' : 'Send verification email'}
              </button>
            )}
            {r.note && <div className="banner info">{r.note}</div>}
            <ErrorBanner error={r.error} />
          </>
        )}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Delete account</h2>
        <p className="muted" style={{ margin: 0 }}>
          Removes your account and your memberships. Orgs where you're the only member are deleted with it, including their environments and stored secrets. This can't be undone.
        </p>
        <button type="button" className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => setDeleting(true)}>
          Delete my account…
        </button>
      </section>
      {deleting && <DeleteAccount onClose={() => setDeleting(false)} />}
    </div>
  )
}

interface OrgBrief {
  slug: string
  name: string
}

function DeleteAccount({ onClose }: { onClose: () => void }) {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [secret, setSecret] = useState('')
  const [orgs, setOrgs] = useState<OrgBrief[] | null>(null)
  const [blocked, setBlocked] = useState<OrgBrief[] | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // Password accounts check `password`; TynHub-only accounts type their email instead.
      await api('/api/auth/account', { method: 'DELETE', body: { password: secret, confirmEmail: secret, deleteOrgs: confirmed } })
      await logout()
      navigate('/', { replace: true })
    } catch (err) {
      const data = err instanceof ApiError ? (err.data as { code?: string; orgs?: OrgBrief[] } | null) : null
      if (data?.code === 'confirm_org_deletion') setOrgs(data.orgs ?? [])
      else if (data?.code === 'transfer_ownership') setBlocked(data.orgs ?? [])
      else setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Delete your account" onClose={onClose}>
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <Field label="Password" hint="Signed up with TynHub and never set a password? Type your email address instead.">
          {(id) => <input id={id} className="input" type="password" autoComplete="current-password" required value={secret} onChange={(e) => setSecret(e.target.value)} />}
        </Field>
        {blocked && (
          <div className="banner" role="alert">
            You're the only owner of {blocked.map((o) => o.name).join(', ')}, which other people use. Make one of them an owner (Settings → Members) or remove them first.
          </div>
        )}
        {orgs && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              Also delete {orgs.map((o) => o.name).join(', ')} and everything in it: jobs, runs, environments and secrets.
            </span>
          </label>
        )}
        <ErrorBanner error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={busy || !secret || (orgs !== null && !confirmed) || blocked !== null}>
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
