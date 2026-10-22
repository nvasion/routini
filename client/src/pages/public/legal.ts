// DRAFT - pending owner review before deploy.
//
// Copy for the Privacy policy and Terms of service pages. Both describe the
// hosted service at routini.tynhub.com, operated by TynHub; self-hosters run
// under their own terms. The categories of data below are the real ones
// Routini's Postgres schema stores (see server/src/db/migrations.ts) — kept
// here as plain structured sections so the pages and this copy can't drift.

export interface LegalSection {
  heading: string
  body: string[]
}

export interface LegalDoc {
  title: string
  updated: string
  sections: LegalSection[]
}

export const LEGAL_CONTACT = 'privacy@tynhub.com'

const UPDATED = 'October 2026'

export const PRIVACY: LegalDoc = {
  title: 'Privacy policy',
  updated: UPDATED,
  sections: [
    {
      heading: 'What this covers',
      body: [
        'This policy covers the hosted alpha at routini.tynhub.com, operated by TynHub. If you run Routini yourself, your own instance stores this same data on your own Postgres, and this policy does not apply to it.',
      ],
    },
    {
      heading: 'What we store',
      body: [
        'Account records: your email, display name and password hash (if you sign in with a password), or an external identity record if you sign in with TynHub or another OAuth/OIDC provider.',
        'Org and membership records: the orgs you belong to and your role in each.',
        'Jobs, runs and logs: the jobs you create, each run’s steps, status and output, and the events that make up its timeline.',
        'Credentials: model keys and integration credentials you add, encrypted at rest and never shown again after you save them.',
        'Fleet records: the servers you connect, their name, group, tags and reported health.',
        'Audit records: approvals and denials, who made them, and policy decisions the run took.',
        'Session cookies and short-lived tokens: your signed-in session, and single-use tokens for password reset and email verification.',
      ],
    },
    {
      heading: 'Why we store it',
      body: [
        'To run the service: authenticate you, run and show the history of your jobs, enforce your org’s approval policy, and let you manage your servers, integrations and keys.',
      ],
    },
    {
      heading: 'Who processes it',
      body: [
        'DigitalOcean hosts the servers the hosted service runs on. Cloudflare sits in front of it for network protection. Our email provider sends verification and password-reset emails on our behalf.',
        'Model providers you configure — Anthropic, OpenRouter, AWS Bedrock, OpenAI, Google, Azure or DigitalOcean — receive the prompts and code your agent steps send, directly from your own account and key, not through us.',
        'If you sign in with TynHub or another OAuth/OIDC provider, that provider confirms your identity to us; we do not receive your password.',
      ],
    },
    {
      heading: 'How long we keep it',
      body: [
        'For as long as your account or org is active. Run history and audit records are kept for operational and security purposes. Password-reset and email-verification tokens expire within minutes to hours and are single-use.',
      ],
    },
    {
      heading: 'Export, deletion and your choices',
      body: [
        `Email ${LEGAL_CONTACT} to request an export of your account and org data, or deletion of your account. We delete what we can without breaking other members' orgs, and tell you what, if anything, we had to keep.`,
      ],
    },
    {
      heading: 'Security',
      body: [
        'Credentials are encrypted at rest and are never returned in API responses or written to logs. Each org’s rows are isolated by row-level security, so one org cannot read another’s data.',
      ],
    },
    {
      heading: 'No sale of data, no ad tracking',
      body: ['We do not sell your personal data, and the hosted service does not run advertising trackers.'],
    },
    {
      heading: 'Changes to this policy',
      body: ['If this policy changes, we will update it here and update the date at the top of this page.'],
    },
    {
      heading: 'Contact',
      body: [`Questions about this policy go to ${LEGAL_CONTACT}.`],
    },
  ],
}

export const TERMS: LegalDoc = {
  title: 'Terms of service',
  updated: UPDATED,
  sections: [
    {
      heading: 'The alpha service',
      body: [
        'Hosted Routini at routini.tynhub.com is provided "as is", during an alpha, with no uptime or support commitment. Features, limits and these terms can change as the alpha continues.',
      ],
    },
    {
      heading: 'Acceptable use',
      body: [
        'Use the service only for lawful purposes, and only against servers, accounts and model keys you are authorized to use. Do not try to bypass the plan limits, the credential broker, or another org’s row-level security.',
      ],
    },
    {
      heading: 'Your servers and your agents',
      body: [
        'You are responsible for the servers you connect with routini-runner, and for any command or agent action you approve. Routini runs what your jobs and approvals tell it to; it is your job to set guardrails you are comfortable with.',
      ],
    },
    {
      heading: 'Your content',
      body: [
        'You own your code, prompts, job definitions and the content of your runs. We do not claim any rights to them beyond what is needed to operate the service on your behalf.',
      ],
    },
    {
      heading: 'Account and termination',
      body: [
        'You can delete your account at any time from Settings → Account. We may suspend or terminate an account that breaks acceptable use or puts the service or other orgs at risk.',
      ],
    },
    {
      heading: 'Changes to these terms',
      body: ['We will update this page and its date when these terms change. Continued use of the hosted service after a change means you accept it.'],
    },
    {
      heading: 'Limitation of liability',
      body: [
        'The hosted service is offered without warranty during the alpha. To the extent the law allows it, TynHub is not liable for indirect, incidental or consequential damages arising from your use of it.',
      ],
    },
    {
      heading: 'Contact',
      body: [`Questions about these terms go to ${LEGAL_CONTACT}.`],
    },
  ],
}
