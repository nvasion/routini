// Public walkthrough: each part of Routini with a screenshot of the real
// console, where to find it, and the details that matter.

import { Link } from 'react-router-dom'
import { STEPS } from './content'
import { PublicLayout, useSignupOpen } from './PublicLayout'
import { Shot } from './Shot'

export function HowItWorksPage() {
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
            From a server you connect to a job that runs on it, the approval it asks for, and the postmortem it drafts. These are screenshots of the console itself, with a
            demo org: real servers, real runs.
          </p>
          {STEPS.map((s, i) => (
            <section key={s.id} id={s.id} className="doc-section walk-step" aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>
                <span className="step-n">{i + 1}</span> {s.title}
              </h2>
              <p className="doc-where">{s.where}</p>
              <p>{s.body}</p>
              {s.points && (
                <ul>
                  {s.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <Shot name={s.shot.name} alt={s.shot.alt} path={s.shot.path} />
            </section>
          ))}
          <div className="card doc-next">
            <strong>Try it on your own servers</strong>
            <span className="muted">Hosted Routini is free during the alpha, or run the whole thing yourself. The getting-started guide takes about five minutes.</span>
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
              <Link className="btn" to="/docs/getting-started">
                Getting started
              </Link>
            </div>
          </div>
        </article>
      </div>
    </PublicLayout>
  )
}
