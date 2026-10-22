// Shared renderer for the two DRAFT legal pages (privacy, terms): one h1, a
// section per h2, and the "Last updated" line. See legal.ts for the copy.

import { usePageMeta } from '../../seo/usePageMeta'
import type { LegalDoc } from './legal'
import { PRIVACY, TERMS } from './legal'
import { PublicLayout } from './PublicLayout'

function LegalDocPage({ doc }: { doc: LegalDoc }) {
  return (
    <PublicLayout>
      <div className="doc">
        <article className="doc-body">
          <h1 className="page-title">{doc.title}</h1>
          <p className="muted">Last updated: {doc.updated}</p>
          {doc.sections.map((s) => (
            <section key={s.heading} className="doc-section" aria-labelledby={`${slugify(s.heading)}-h`}>
              <h2 id={`${slugify(s.heading)}-h`}>{s.heading}</h2>
              {s.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </section>
          ))}
        </article>
      </div>
    </PublicLayout>
  )
}

function slugify(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function PrivacyPage() {
  usePageMeta()
  return <LegalDocPage doc={PRIVACY} />
}

export function TermsPage() {
  usePageMeta()
  return <LegalDocPage doc={TERMS} />
}
