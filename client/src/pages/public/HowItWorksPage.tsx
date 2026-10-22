// Public walkthrough and setup guide in one: from a new account to a job on
// your own server, with a screenshot of the real console where there is one,
// the command to copy where there is one, and where to find it all.
// /docs/getting-started redirects here (keeping its #anchors).

import { Link } from 'react-router-dom'
import { usePageMeta } from '../../seo/usePageMeta'
import { STEPS } from './content'
import { PublicLayout, REPO_URL, useSignupOpen } from './PublicLayout'
import { Shot } from './Shot'

export function HowItWorksPage() {
  usePageMeta()
  const signupOpen = useSignupOpen()
  return (
    <PublicLayout>
      <div className="doc">
        <aside className="doc-toc" aria-label="On this page">
          <span className="nav-label">How it works</span>
          <ol>
            {STEPS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </aside>
        <article className="doc-body">
          <h1 className="page-title">How Routini works</h1>
          <p className="lead">
            From a new account to a job running on your own server in about five minutes, then the parts that make it safe to leave running. The screenshots are of the
            console itself, with a demo org: real servers, real runs.
          </p>
          {signupOpen === false && (
            <p className="muted">
              This server has signup closed: <Link to="/login">sign in</Link> with the account an admin made for you.
            </p>
          )}
          {STEPS.map((s, i) => (
            <section key={s.id} id={s.id} className="doc-section walk-step" aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>
                <span className="step-n">{i + 1}</span> {s.title}
              </h2>
              {s.where && <p className="doc-where">{s.where}</p>}
              <p>{s.body}</p>
              {s.code && <pre className="code doc-code">{s.code}</pre>}
              {s.note && <p className="muted">{s.note}</p>}
              {s.points && (
                <ul>
                  {s.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {s.shot && <Shot name={s.shot.name} alt={s.shot.alt} path={s.shot.path} />}
            </section>
          ))}
          <div className="card doc-next">
            <strong>Ready?</strong>
            <span className="muted">Everything above runs on your own model keys, hosted (free during the alpha) or on your own machine.</span>
            <div className="inline">
              {signupOpen !== false ? (
                <Link className="btn primary" to="/signup">
                  Create your account
                </Link>
              ) : (
                <Link className="btn primary" to="/login">
                  Sign in
                </Link>
              )}
              <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer">
                Read the README
              </a>
            </div>
          </div>
        </article>
      </div>
    </PublicLayout>
  )
}
