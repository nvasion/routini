// The public front page: what Routini is, what it does, and the way in.

import { Link } from 'react-router-dom'
import emblemLg from '../../brand/emblem-lg.webp'
import wordmark from '../../brand/wordmark.webp'
import character from '../../brand/character.webp'
import { PublicLayout, REPO_URL, useSignupOpen } from './PublicLayout'

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

const STEPS: Array<{ title: string; body: string }> = [
  { title: 'Create your account', body: 'Sign up with email, or continue with TynHub.' },
  { title: 'Add a model key', body: 'Bring your own Anthropic, OpenRouter or other key. It is stored encrypted and never shown again.' },
  { title: 'Connect a server', body: 'Run the one-line install from Fleet → Add server. The runner connects out and shows up live.' },
  { title: 'Create your first job', body: 'A schedule and a command, or an agent with a repository. Watch it run in the timeline.' },
]

export function LandingPage() {
  const signupOpen = useSignupOpen()
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
        <p className="hero-lead">
          Routini runs the routine work across your code and servers: scheduled jobs, coding agents that open pull requests, commands on your fleet, and runbooks when
          alerts fire. It asks before it touches anything that matters.
        </p>
        <div className="hero-cta">
          {signupOpen !== false ? (
            <Link className="btn primary hero-btn" to="/signup">
              Get started, free
            </Link>
          ) : (
            <Link className="btn primary hero-btn" to="/login">
              Sign in
            </Link>
          )}
          <Link className="btn hero-btn" to="/docs/getting-started">
            Read the 5-minute guide
          </Link>
        </div>
        <p className="hero-note">Bring your own model keys. Self-host it, or use it on TynHub.</p>
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

      <section className="public-section how" aria-labelledby="how">
        <div className="how-art" aria-hidden="true">
          <img src={character} alt="" />
        </div>
        <div className="how-body">
          <h2 id="how" className="public-h2">
            Up and running in four steps
          </h2>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="step-n">{i + 1}</span>
                <span>
                  <strong>{s.title}</strong>
                  <span className="muted"> {s.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <div className="inline">
            <Link className="btn primary" to="/docs/getting-started">
              Walk through the guide
            </Link>
            <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer">
              View the source
            </a>
          </div>
        </div>
      </section>
    </PublicLayout>
  )
}
