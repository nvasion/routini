// Settings → General: link this org to a TynHub org. Members of that TynHub
// org who "Continue with TynHub" join here (TynHub owners/admins as admins).

import { useEffect, useState, type FormEvent } from 'react'
import { ErrorBanner, Field } from '../components/ui'
import { api } from '../lib/api'
import { useApi } from '../lib/hooks'
import { useOrg } from '../shell/OrgContext'

export function TynhubLink() {
  const org = useOrg()
  const providers = useApi<{ oidc: { name: string } | null }>('/api/auth/providers')
  const [slug, setSlug] = useState(org.org?.tynhubOrg ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => setSlug(org.org?.tynhubOrg ?? ''), [org.org?.tynhubOrg])
  const name = providers.data?.oidc?.name ?? 'TynHub'

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await api(org.api('/tynhub'), { method: 'PUT', body: { tynhubOrg: slug.trim() || null } })
      await org.reload()
      setNote(slug.trim() ? `Linked. Members of ${slug.trim()} on ${name} join this org when they sign in.` : 'Unlinked.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={save} aria-labelledby="tynhub-h">
      <h3 id="tynhub-h" style={{ margin: 0 }}>
        Org on {name}
      </h3>
      <p className="muted" style={{ margin: 0 }}>
        Link this org to your {name} org. Its members can then sign in with &ldquo;Continue with {name}&rdquo; and join here: {name} owners and admins as admins, everyone else as
        members. Existing members are never changed or removed.
      </p>
      {providers.data && !providers.data.oidc && <span className="meta">Sign-in with {name} is not configured on this server yet (ROUTINI_OIDC_*).</span>}
      <fieldset disabled={!org.can('owner') || busy} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <Field label={`${name} org slug`} hint="Leave blank to unlink.">
          {(id) => <input id={id} className="input mono" value={slug} placeholder="acme" onChange={(e) => setSlug(e.target.value)} />}
        </Field>
        {org.can('owner') ? (
          <button type="submit" className="btn" style={{ alignSelf: 'flex-start' }}>
            {busy ? 'Saving…' : 'Save link'}
          </button>
        ) : (
          <span className="muted">Only owners can link the org.</span>
        )}
      </fieldset>
      {note && <div className="banner info">{note}</div>}
      <ErrorBanner error={error} />
    </form>
  )
}
