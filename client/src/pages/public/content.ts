// Copy shared by the public pages. Keep it true to what ships: anything not
// live yet goes in NEXT, not in the steps or features. The screenshots are of
// the real console, seeded by scripts/shots.mjs; a step's text should describe
// what its shot shows.

import { REPO_URL } from './PublicLayout'

export interface Step {
  /** Also the anchor; ids from the old /docs/getting-started page are kept so its links still land. */
  id: string
  title: string
  /** Where this happens in the console, shown as "Settings → …". */
  where?: string
  body: string
  /** Screenshot name in src/assets/shots, and the console path it shows. */
  shot?: { name: string; path: string; alt: string }
  points?: string[]
  /** A command or template to copy, shown as a code block. */
  code?: string
  /** A smaller follow-up line under the code. */
  note?: string
}

export const STEPS: Step[] = [
  {
    id: 'account',
    title: 'Create your account',
    where: 'Sign up',
    body: 'Sign up with your email, or use Continue with TynHub where your server offers it, and confirm your email from the link we send. Your account starts with its own org, a workspace for jobs, servers and people; invite others under Settings → Members. Hosted Routini is free during the alpha.',
    points: [
      'On the hosted version, agent steps and environments wait until the org’s owner has confirmed their email',
      'Plan limits cover Routini’s own compute only (2 runs at a time, 1 running environment, 120 agent minutes a day); work on your own servers isn’t counted',
      'On a server you run yourself, the first account owns it, and further signups are closed unless you open them',
    ],
  },
  {
    id: 'model',
    title: 'Add a model key',
    where: 'Settings → Models',
    body: 'Coding agents run on your own model account. Choose an agent and its provider and paste your key: Claude Code works with Anthropic, OpenRouter and AWS Bedrock (with an AWS region); Omnimancer also takes OpenAI, Google, Azure and DigitalOcean. Keys are encrypted and never shown again. You can skip this until you want agents: HTTP checks and commands work without it.',
  },
  {
    id: 'server',
    title: 'Connect your servers',
    where: 'Fleet → Add server',
    body: 'Give the server a name, group and tags, and run the install command it gives you on the server. routini-runner dials out to Routini over HTTPS, so there are no inbound ports and no SSH keys to hand over. Each server shows up with live disk, memory and load.',
    code: `curl -fsSL https://raw.githubusercontent.com/nvasion/routini-runner/main/scripts/install.sh \\
  | sudo sh -s -- --url https://your-routini --token rre_… --enable-agents`,
    note: 'Leave off --enable-agents for a server that should only run commands, not agents and environments (those need Docker). Prefer SSH? Add the host under Settings → Hosts with a key from Settings → Credentials.',
    shot: {
      name: 'fleet',
      path: '/o/northwind/fleet',
      alt: 'Fleet: four servers in the build, db and web groups, all online on routini-runner 0.4.1, with disk and memory meters; build-01 can run agents. The dock on the right lists the same servers.',
    },
    points: ['An audited browser terminal on any server, from the card or the dock', 'New runner versions install from the server’s page in Fleet'],
  },
  {
    id: 'job',
    title: 'Describe the job',
    where: 'Jobs → New job',
    body: 'A job is a trigger and its steps. Here a coding agent bumps the storefront’s dependencies every weekday at 3 a.m. Pacific, runs npm test, and opens a pull request. Its Run on is a pool, so it runs on whichever build server is least busy, and the editor checks that one can take it. Press Run now on any job and watch the output stream in.',
    shot: {
      name: 'job',
      path: '/o/northwind/jobs',
      alt: 'The job editor: a schedule trigger, and an agent step with its prompt, Claude Code as the agent, "Run on: a host from a pool" with group build and tag ci, and "1 runner hosts match; 1 can run agents now"',
    },
    points: [
      'Triggers: by hand, on a schedule (cron with a time zone), from a webhook, or when an alert fires',
      'Steps: HTTP checks, commands on servers, IMAP checks, Azure Boards queries, Teams messages, Factory builds, coding agents and approvals',
      'Run on: Routini’s sandbox, one of your servers, the alert’s host, or a pool by group and tags',
      'A first job to try: a schedule of 0 */6 * * * with a command step running df -h / on your server',
    ],
  },
  {
    id: 'guardrails',
    title: 'Set the guardrails',
    where: 'Settings → Policy',
    body: 'Your org policy decides what needs a person. Out of the box, any command on a server tagged prod waits for an admin, and the job editor shows each step’s decision as you build it. Agents reach the internet only through the credential broker: it allows the hosts on your list, adds real keys outside their sandbox, and the run names every host it refused.',
    shot: {
      name: 'policy',
      path: '/o/northwind/settings/policy',
      alt: 'Settings, Policy: the credential broker on, and the rule "Commands on production hosts need approval" for commands on hosts tagged prod, approved by admins',
    },
  },
  {
    id: 'approve',
    title: 'Approve what matters',
    where: 'Inbox',
    body: 'Anything waiting on you lands in the Inbox, next to what is running now and what is coming up. Approve or deny in one click, with a comment that stays in the run’s history. Agents and MCP clients can never approve anything.',
    shot: {
      name: 'inbox',
      path: '/o/northwind/inbox',
      alt: 'The Inbox: an approval for "Rotate nginx logs" that needs an admin, with Approve and Deny; the run waiting under Live now; and the next scheduled runs under Coming up',
    },
  },
  {
    id: 'run',
    title: 'Watch it run',
    where: 'Runs → a run',
    body: 'Every run has a live timeline: which policy asked for approval and who gave it, the command’s output as it streams, and where each step ran, on one of your servers or in Routini’s sandbox. This run is a disk runbook an alert started on web-02.',
    shot: {
      name: 'run',
      path: '/o/northwind/runs/6',
      alt: 'A run of the Disk runbook, triggered by an alert: each command ran on web-02 via routini-runner after Jordan Rivera approved it under the production policy, with the df and du output shown',
    },
  },
  {
    id: 'alerts',
    title: 'Turn alerts into postmortems',
    where: 'Settings → Alerts, then Incidents',
    body: 'Create a token under Settings → Alerts and point Alertmanager, Grafana or any webhook at the URL shown there. A firing alert opens an incident; give a job an Alert trigger and it runs on the server the alert names. Use the alert’s values, and earlier steps’ output, in commands and prompts:',
    code: `df -h {{alert.labels.mount}}            # passed safely, never as shell code
Summarize: {{steps.diag.stdout}}        # an earlier step's output, in an agent prompt`,
    note: 'When the alert clears, the incident closes and Routini drafts the postmortem from what actually happened, ready for you to finish.',
    shot: {
      name: 'incident',
      path: '/o/northwind/incidents/1',
      alt: 'A resolved incident, DiskAlmostFull on web-02: the alert’s labels, a timeline from alert to runbook to resolution, and a generated postmortem draft',
    },
  },
  {
    id: 'integrations',
    title: 'Connect your tools',
    where: 'Integrations',
    body: 'Connect GitHub, GitLab, Azure DevOps, Jira, Linear, Slack, Teams, Sentry, PagerDuty, Datadog, Cloudflare, DigitalOcean or Factory, and choose which agents may use each one. Agents only ever hold a placeholder; the broker adds the real key on the way out. Azure Boards and Teams are steps too: read your backlog, then post the result.',
    code: `Pick the oldest bug and fix it: {{steps.backlog.summary}}   # agent prompt
Nightly triage: {{steps.fix.summary}}                       # Teams message`,
    shot: {
      name: 'integrations',
      path: '/o/northwind/integrations',
      alt: 'Integrations: cards for GitHub, Slack, Jira, Notion, Linear, monday.com, HubSpot, Azure DevOps, Microsoft Teams, GitLab, DigitalOcean, Sentry, PagerDuty, Datadog, Cloudflare and Factory, with ttyy.ai coming soon',
    },
  },
  {
    id: 'environments',
    title: 'Keep an environment',
    where: 'Environments → New environment',
    body: 'An environment is a container that stays up between runs, with your repository cloned into /workspace and a browser terminal. Choose its host: Routini’s compute, or one of your agent-enabled servers, where it runs behind that server’s own egress proxy and doesn’t count against your plan. It stops when idle, and you start it again from the same page.',
  },
  {
    id: 'mcp',
    title: 'Use Routini from Claude Code',
    where: 'Settings → API tokens',
    body: 'Create a token and add Routini as an MCP server. Then ask “what failed overnight?”, “run the disk check on web-01” or “what’s open right now?”. Commands follow your policy like any run, and approving is never something a client can do.',
    code: `claude mcp add --transport http routini https://your-routini/mcp \\
  --header "Authorization: Bearer rtk_…"`,
  },
  {
    id: 'self-host',
    title: 'Run it yourself',
    body: 'Routini is open source (AGPL-3.0, the runner Apache-2.0). On any machine with Docker, this brings up Routini and a connected runner, then prints your login:',
    code: `git clone ${REPO_URL}.git && cd routini
make local        # stack + a connected runner on http://localhost:8088`,
    note: 'For a server install, copy .env.example to .env, set the three secrets, run make agents, then docker compose up --build -d. The README covers configuration, the credential broker and signing in with TynHub.',
  },
]

/** The steps the front page previews; /how-it-works has all of them. */
export const PREVIEW = ['server', 'job', 'run', 'alerts']

export const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: 'Jobs and coding agents',
    body: 'Schedules, webhooks and alerts start jobs. Steps call APIs, run commands, or hand a task to a coding agent (Claude Code or Omnimancer) that works in a sandbox, runs your checks and opens a pull request.',
  },
  {
    title: 'Agents on your own servers',
    body: 'Run agent steps and persistent environments on your own hosts instead of Routini’s: pick a server, the alert’s host, or a pool by group and tags. Keys stay in a broker on that host, and your own compute never counts against your plan.',
  },
  {
    title: 'Your fleet, without the keys',
    body: 'Connect servers with routini-runner, a small open-source agent that only dials out: no inbound ports, no SSH keys stored in Routini. Live health, audited terminals, commands from jobs, and runner updates from the console.',
  },
  {
    title: 'Alerts to runbooks to postmortems',
    body: 'Alertmanager, Grafana or any webhook opens an incident and runs the matching runbook on the affected server. When it resolves, Routini drafts the postmortem from what actually happened.',
  },
  {
    title: 'Plugged into your tools',
    body: 'GitHub, GitLab, Azure DevOps, Jira, Linear, Slack, Teams, Sentry, PagerDuty, Datadog, Cloudflare, DigitalOcean and Factory. Query an Azure Boards backlog or post to a Teams channel as a step, and choose which agents may use each one.',
  },
  {
    title: 'Guardrails by default',
    body: 'Org policy decides what needs a person to approve it. Agents work behind a credential broker that keeps real keys out of their sandbox and refuses hosts off your allow-list, and the run says which ones it refused. Nothing approves itself.',
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

// Shown as marks under "What it does"; ids match the console's integration catalog.
export const INTEGRATIONS: Array<[id: string, name: string]> = [
  ['github', 'GitHub'],
  ['gitlab', 'GitLab'],
  ['azure-devops', 'Azure DevOps'],
  ['jira', 'Jira'],
  ['linear', 'Linear'],
  ['slack', 'Slack'],
  ['teams', 'Microsoft Teams'],
  ['sentry', 'Sentry'],
  ['pagerduty', 'PagerDuty'],
  ['datadog', 'Datadog'],
  ['cloudflare', 'Cloudflare'],
  ['digitalocean', 'DigitalOcean'],
  ['factory', 'Factory'],
]

export const SHIPPED = [
  'Hosted alpha at routini.tynhub.com, free while in alpha',
  'Jobs, runs and approvals on Postgres, with a live timeline that shows where each step ran',
  'Coding agents in sandboxes that open pull requests: Claude Code and Omnimancer',
  'Model keys for Anthropic, OpenRouter, AWS Bedrock, OpenAI, Google, Azure and DigitalOcean',
  'routini-runner: the fleet without inbound ports, updated from the console',
  'Agents and environments on your own servers, with host pools',
  'Persistent environments with browser terminals',
  'Org policy, approvals and the credential broker',
  'Alerts → incidents → runbooks → postmortems',
  '13 integrations, with Azure Boards and Teams steps',
  'Routini as an MCP server for Claude Code',
  'Email verification, password reset and account deletion',
]

export const NEXT = [
  'Start a job when a board work item changes',
  'Run notifications to Slack and Teams',
  'Import DigitalOcean droplets into the fleet',
  'Sign in with TynHub across the network',
  'ttyy.ai integration',
  'Paid plans with more managed compute',
]

export const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'What does it cost?',
    a: 'Running it yourself is free: it is open source. Hosted Routini is free during the alpha, with limits on Routini’s own compute (2 runs at a time, 1 running environment, 120 agent minutes a day). Agents and environments on your own servers are not counted. You bring your own model keys, so model spend goes to your own provider account.',
  },
  {
    q: 'Do I have to open my servers to the internet?',
    a: 'No. routini-runner only dials out to Routini over HTTPS, so there are no inbound ports, and Routini never stores SSH keys for runner servers. SSH hosts are supported too, if you prefer them.',
  },
  {
    q: 'Can agents run on my own servers?',
    a: 'Yes. Install the runner with --enable-agents on a host with Docker, then choose that host, the alert’s host, or a pool in the step’s “Run on”. The runner starts a local credential broker next to the agent, so keys never enter its container and your allow-list still applies.',
  },
  {
    q: 'Can an agent change production on its own?',
    a: 'Only if your policy allows it. Rules can require a person to approve commands on servers tagged prod, branch pushes and more. Agents and MCP clients cannot approve anything, including their own work.',
  },
  {
    q: 'Which models and agents?',
    a: 'Claude Code and Omnimancer run agent steps, with your own key. Claude Code works with Anthropic, OpenRouter and AWS Bedrock; Omnimancer adds OpenAI, Google, Azure and DigitalOcean.',
  },
  {
    q: 'Where does my data live?',
    a: 'In your Postgres when you self-host. On the hosted version, each org’s rows are kept apart by row-level security. Secrets are encrypted at rest, scoped to their org, and never shown again after you save them.',
  },
  {
    q: 'Are the screenshots real?',
    a: 'Yes: they are the console itself, with a demo org. Each server is a real routini-runner (running in a container), and the runs really ran, under the same default policy you get. Only the agent’s reply is a recorded one, so making them costs no model spend.',
  },
]
