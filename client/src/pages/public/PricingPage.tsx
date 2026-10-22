// Pricing: three plans, their real limits and facts from content.ts (no
// invented numbers), and a short FAQ with its own JSON-LD (see seo/jsonLd.ts).

import { Link } from 'react-router-dom'
import { usePageMeta } from '../../seo/usePageMeta'
import { PRICING_FAQ } from './content'
import { PublicLayout, REPO_URL, useSignupOpen } from './PublicLayout'

interface Plan {
  name: string
  price: string
  tagline: string
  points: string[]
  cta: { label: string; to?: string; href?: string }
}

export function PricingPage() {
  usePageMeta()
  const signupOpen = useSignupOpen()
  const plans: Plan[] = [
    {
      name: 'Self-hosted',
      price: 'Free',
      tagline: 'Open source (AGPL-3.0). Run it anywhere.',
      points: ['Unlimited runs, jobs and servers', 'Your own Postgres and model keys', 'The runner is Apache-2.0'],
      cta: { label: 'Run it yourself', href: '/how-it-works#self-host' },
    },
    {
      name: 'Hosted alpha',
      price: 'Free',
      tagline: 'Free while in alpha.',
      points: [
        '2 runs at a time, 1 running environment',
        '120 agent minutes a day on Routini’s compute',
        'Agents and environments on your own servers are not counted',
        'Bring your own model keys',
      ],
      cta: { label: signupOpen === false ? 'Sign in' : 'Get started, free', to: signupOpen === false ? '/login' : '/signup' },
    },
    {
      name: 'Hosted paid',
      price: 'After the alpha',
      tagline: 'More runs and managed compute.',
      points: ['Pricing will be announced before the alpha ends.'],
      cta: { label: 'See how it works', to: '/how-it-works' },
    },
  ]

  return (
    <PublicLayout>
      <section className="public-section" aria-labelledby="pricing-h">
        <h1 id="pricing-h" className="page-title">
          Pricing
        </h1>
        <p className="lead">Self-host for free, or use the hosted alpha free with fair limits on Routini’s own compute.</p>
        <div className="feature-grid plan-grid">
          {plans.map((p) => (
            <article key={p.name} className="card plan-card">
              <h3>{p.name}</h3>
              <p className="plan-price">{p.price}</p>
              <p className="muted">{p.tagline}</p>
              <ul className="plan-points">
                {p.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
              {p.cta.to ? (
                <Link className="btn primary" to={p.cta.to}>
                  {p.cta.label}
                </Link>
              ) : (
                <a className="btn primary" href={p.cta.href}>
                  {p.cta.label}
                </a>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="public-section" aria-labelledby="pricing-faq">
        <h2 id="pricing-faq" className="public-h2">
          Questions
        </h2>
        <div className="faq">
          {PRICING_FAQ.map((f) => (
            <details key={f.q} className="card">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        <p className="muted">
          More on servers, keys and guardrails is in <Link to="/how-it-works">how it works</Link>, or read the source on{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      </section>
    </PublicLayout>
  )
}
