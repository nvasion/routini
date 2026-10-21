// The public front page, campaign style: a bold pitch, how it works in four
// screenshots of the real console, the story behind it (with "Read more"), then
// how to install, what it does, where it's at, and the questions people ask first.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import emblemLg from '../../brand/emblem-lg.webp'
import wordmark from '../../brand/wordmark.webp'
import character from '../../brand/character.webp'
import { IntegrationIcon } from '../../components/IntegrationIcon'
import { FAQ, FEATURES, INTEGRATIONS, NEXT, PREVIEW, SHIPPED, STEPS } from './content'
import { PublicLayout, REPO_URL, RUNNER_REPO_URL, useSignupOpen } from './PublicLayout'
import { Shot } from './Shot'

const BADGES = ['Open source · AGPL-3.0', 'Hosted free during the alpha', 'No inbound ports', 'Bring your own model keys', 'Self-host in one command']

function CopyBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-block">
      <pre className="code" aria-label={label}>
        {code}
      </pre>
      <button
        type="button"
        className="btn small copy-btn"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(code)
            .then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => {})
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

type InstallTab = 'hosted' | 'self' | 'server'

export function LandingPage() {
  const signupOpen = useSignupOpen()
  const [more, setMore] = useState(false)
  const [tab, setTab] = useState<InstallTab>('self')
  const primary =
    signupOpen !== false ? (
      <Link className="btn primary hero-btn" to="/signup">
        Get started, free
      </Link>
    ) : (
      <Link className="btn primary hero-btn" to="/login">
        Sign in
      </Link>
    )

  return (
    <PublicLayout>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-art">
          <img src={emblemLg} alt="" width={210} height={210} />
          <img src={wordmark} alt="Routini" className="hero-wordmark" />
        </div>
        <h1 id="hero-title" className="hero-title">
          Your AI engineer, on call.
        </h1>
        <p className="hero-lead">Hand Routini the routine: jobs, fleet commands, coding agents and incident runbooks. It does the work and asks before anything that matters.</p>
        <div className="hero-cta">
          {primary}
          <Link className="btn hero-btn" to="/how-it-works">
            See how it works
          </Link>
        </div>
        <ul className="badges" aria-label="Highlights">
          {BADGES.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </section>

      <section className="public-section" aria-labelledby="how">
        <h2 id="how" className="public-h2">
          How it works
        </h2>
        <ol className="preview-steps">
          {STEPS.filter((s) => PREVIEW.includes(s.id)).map((s, i) => (
            <li key={s.id} className="card preview-step">
              {s.shot && <Shot name={s.shot.name} alt={s.shot.alt} path={s.shot.path} />}
              <div className="preview-body">
                <span className="step-n">{i + 1}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <Link className="install-more" to="/how-it-works">
          The full walkthrough, screen by screen →
        </Link>
      </section>

      <section id="story" className="public-section story" aria-labelledby="story-h">
        <div className="story-art" aria-hidden="true">
          <img src={character} alt="" />
        </div>
        <div className="story-body">
          <h2 id="story-h" className="public-h2">
            Why Routini
          </h2>
          <p className="story-lead">
            Every team has a list of work nobody should do by hand anymore: the nightly checks, the dependency bumps, the disk that fills up at 3 a.m., the runbook everyone
            half remembers. Routini is the engineer who takes that list, and calls you only when it should.
          </p>
          <div className="story-more" id="story-more" hidden={!more}>
            <p>
              <strong>It works where you work.</strong> Jobs start on a schedule, from a webhook, or when an alert fires. Each step is a check, a command on one of your
              servers, a query of your Azure Boards backlog, a message to Teams, or a coding agent that clones your repository, makes the change, runs your tests and opens
              a pull request for review.
            </p>
            <p>
              <strong>It reaches your servers without opening them.</strong> The routini-runner agent connects out to Routini, so you never expose SSH or hand over keys.
              You see each server&rsquo;s health live, open an audited terminal, and point runbooks at whichever host an alert names. Let the runner host agents too, and
              the work runs on your own hardware, with the keys kept on that host.
            </p>
            <p>
              <strong>It knows when to stop and ask.</strong> Your org policy decides which steps need a person to approve them. Agents run in sandboxes behind a
              credential broker, so real keys never reach them. And nothing in Routini can approve its own work.
            </p>
            <p>
              <strong>It&rsquo;s yours.</strong> Routini is open source. Run it on your own machine in one command, or use it hosted on TynHub. Connect it to Claude Code and
              ask it about your systems in plain language.
            </p>
          </div>
          <button type="button" className="btn small read-more" aria-expanded={more} aria-controls="story-more" onClick={() => setMore((m) => !m)}>
            {more ? 'Read less' : 'Read more'}
          </button>
        </div>
      </section>

      <section id="install" className="public-section install" aria-labelledby="install-h">
        <h2 id="install-h" className="public-h2">
          Install
        </h2>
        <div className="segmented install-tabs" role="tablist" aria-label="Install options">
          {(
            [
              ['self', 'Run it yourself'],
              ['hosted', 'Use it hosted'],
              ['server', 'Connect a server'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="card install-card" role="tabpanel">
          {tab === 'self' && (
            <>
              <p>On any machine with Docker. This brings up Routini and a connected runner, then prints your login.</p>
              <CopyBlock label="Run it yourself" code={`git clone ${REPO_URL}.git && cd routini\nmake local          # → http://localhost:8088`} />
              <p className="muted">
                For a server, copy <span className="mono">.env.example</span> to <span className="mono">.env</span>, set the three secrets, then{' '}
                <span className="mono">make agents && docker compose up --build -d</span>.
              </p>
            </>
          )}
          {tab === 'hosted' && (
            <>
              <ol className="steps">
                <li>
                  <span className="step-n">1</span>
                  <span>
                    <strong>Create your account</strong>
                    <span className="muted"> with email and confirm it from your inbox. It is free during the alpha.</span>
                  </span>
                </li>
                <li>
                  <span className="step-n">2</span>
                  <span>
                    <strong>Add a model key</strong>
                    <span className="muted"> in Settings → Models. It is stored encrypted and never shown again.</span>
                  </span>
                </li>
                <li>
                  <span className="step-n">3</span>
                  <span>
                    <strong>Connect a server</strong>
                    <span className="muted"> from Fleet → Add server, and create your first job.</span>
                  </span>
                </li>
              </ol>
              <div className="inline">{primary}</div>
            </>
          )}
          {tab === 'server' && (
            <>
              <p>
                In Routini, open <strong>Fleet → Add server</strong> for a one-time token, then run this on the server. The runner dials out over HTTPS: no inbound ports, no
                SSH keys.
              </p>
              <CopyBlock
                label="Connect a server"
                code={`curl -fsSL https://raw.githubusercontent.com/nvasion/routini-runner/main/scripts/install.sh \\\n  | sudo sh -s -- --url https://your-routini --token rre_… --enable-agents`}
              />
              <p className="muted">
                Leave off <span className="mono">--enable-agents</span> if the server should only run commands, not agents and environments. Docker and manual installs are
                on the same screen, and later updates are one click in Fleet. The runner is{' '}
                <a href={RUNNER_REPO_URL} target="_blank" rel="noreferrer">
                  open source (Apache-2.0)
                </a>
                .
              </p>
            </>
          )}
        </div>
        <Link className="install-more" to="/how-it-works">
          The full 5-minute walkthrough: first job, guardrails, alerts, Claude Code →
        </Link>
      </section>

      <section className="public-section" aria-labelledby="what">
        <h2 id="what" className="public-h2">
          What it does
        </h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article key={f.title} className="card feature">
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
        <ul className="integration-strip" aria-label="Integrations">
          {INTEGRATIONS.map(([id, name]) => (
            <li key={id} title={name}>
              <IntegrationIcon id={id} name={name} size={40} />
              <span>{name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="public-section" aria-labelledby="progress">
        <h2 id="progress" className="public-h2">
          Where it&rsquo;s at
        </h2>
        <div className="progress-grid">
          <div className="card">
            <h3 className="progress-h done">Shipped</h3>
            <ul className="progress-list">
              {SHIPPED.map((s) => (
                <li key={s}>
                  <span className="tick" aria-hidden="true">
                    ✓
                  </span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h3 className="progress-h next">Next</h3>
            <ul className="progress-list">
              {NEXT.map((s) => (
                <li key={s}>
                  <span className="tick next" aria-hidden="true">
                    →
                  </span>
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="public-section" aria-labelledby="faq">
        <h2 id="faq" className="public-h2">
          Questions
        </h2>
        <div className="faq">
          {FAQ.map((f) => (
            <details key={f.q} className="card">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="final-cta" aria-label="Get started">
        <h2 className="public-h2">Give the routine to Routini.</h2>
        <div className="hero-cta">
          {primary}
          <Link className="btn hero-btn" to="/how-it-works">
            See how it works
          </Link>
        </div>
      </section>
    </PublicLayout>
  )
}
