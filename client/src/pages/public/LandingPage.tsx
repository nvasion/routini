// The public front page, campaign style: a bold pitch, the story behind it
// (with "Read more"), then how to install, what it does, where it's at, and
// the questions people ask first.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import emblemLg from '../../brand/emblem-lg.webp'
import wordmark from '../../brand/wordmark.webp'
import character from '../../brand/character.webp'
import { PublicLayout, REPO_URL, RUNNER_REPO_URL, useSignupOpen } from './PublicLayout'

const BADGES = ['Open source · AGPL-3.0', 'No inbound ports', 'Bring your own model keys', 'Self-host in one command']

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: 'Jobs and coding agents',
    body: 'Schedules, webhooks and alerts start jobs. Steps call APIs, run commands, or hand a task to a coding agent that works in a sandbox, runs your checks and opens a pull request.',
  },
  {
    title: 'Your fleet, without the keys',
    body: 'Connect servers with routini-runner, a small open-source agent that only dials out: no inbound ports, no SSH keys stored in Routini. Live health, audited terminals, and commands from jobs.',
  },
  {
    title: 'Alerts to runbooks to postmortems',
    body: 'Alertmanager, Grafana or any webhook opens an incident and runs the matching runbook on the affected server. When it resolves, Routini drafts the postmortem from what actually happened.',
  },
  {
    title: 'Guardrails by default',
    body: 'Org policy decides what needs a person to approve it. Agents work behind a credential broker that keeps real keys out of their sandbox. Nothing approves itself.',
  },
  {
    title: 'From Claude Code',
    body: 'Connect Claude Code or any MCP client with an API token. Ask what failed overnight, start a job, run a command on a server, all under the same policy.',
  },
  {
    title: 'Open source, run it anywhere',
    body: 'AGPL-3.0, with the runner under Apache-2.0. Use the hosted version on TynHub, or run the whole thing on your own machine with Docker Compose.',
  },
]

const SHIPPED = [
  'Jobs, runs and approvals on Postgres, with a live timeline',
  'Coding agents in sandboxes that open pull requests',
  'Persistent environments with browser terminals',
  'Org policy, approvals and the credential broker',
  'routini-runner: the fleet without inbound ports',
  'Alerts → incidents → runbooks → postmortems',
  'Routini as an MCP server for Claude Code',
]
const NEXT = ['routini-runner v0.1.0 release (binaries and image)', 'Hosted alpha at routini.tynhub.com', 'Sign in with TynHub across the network']

const FAQ: Array<{ q: string; a: string }> = [
  { q: 'What does it cost?', a: 'Running it yourself is free: it is open source. You bring your own model keys, so model spend goes to your own provider account.' },
  {
    q: 'Do I have to open my servers to the internet?',
    a: 'No. routini-runner only dials out to Routini over HTTPS, so there are no inbound ports, and Routini never stores SSH keys for runner servers. SSH hosts are supported too, if you prefer them.',
  },
  {
    q: 'Can an agent change production on its own?',
    a: 'Only if your policy allows it. Rules can require a person to approve commands on servers tagged prod, branch pushes and more. Agents and MCP clients cannot approve anything, including their own work.',
  },
  { q: 'Which models and agents?', a: 'Claude Code runs agent steps today, on Anthropic, OpenRouter, OpenAI, Google, DigitalOcean and other endpoints, with your own key.' },
  { q: 'Where does my data live?', a: 'In your Postgres when you self-host. Secrets are encrypted at rest, scoped to their org, and never shown again after you save them.' },
]

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
          <a className="btn hero-btn" href="#story" onClick={() => setMore(true)}>
            Read more ↓
          </a>
        </div>
        <ul className="badges" aria-label="Highlights">
          {BADGES.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
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
              servers, or a coding agent that clones your repository, makes the change, runs your tests and opens a pull request for review.
            </p>
            <p>
              <strong>It reaches your servers without opening them.</strong> The routini-runner agent connects out to Routini, so you never expose SSH or hand over keys.
              You see each server&rsquo;s health live, open an audited terminal, and point runbooks at whichever host an alert names.
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
                    <span className="muted"> with email, or continue with TynHub.</span>
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
                code={`curl -fsSL https://raw.githubusercontent.com/nvasion/routini-runner/main/scripts/install.sh \\\n  | sudo sh -s -- --url https://your-routini --token rre_…`}
              />
              <p className="muted">
                Docker and manual installs are on the same screen. The runner is{' '}
                <a href={RUNNER_REPO_URL} target="_blank" rel="noreferrer">
                  open source (Apache-2.0)
                </a>
                .
              </p>
            </>
          )}
        </div>
        <Link className="install-more" to="/docs/getting-started">
          The full 5-minute guide: first job, guardrails, alerts, Claude Code →
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
          <Link className="btn hero-btn" to="/docs/getting-started">
            Read the guide
          </Link>
        </div>
      </section>
    </PublicLayout>
  )
}
