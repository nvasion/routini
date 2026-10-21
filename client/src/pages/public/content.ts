// Copy shared by the public pages. Keep it true to what ships: anything not
// live yet goes in NEXT, not in the steps or features. The screenshots are of
// the real console, seeded by scripts/shots.mjs; a step's text should describe
// what its shot shows.

export interface Step {
  id: string
  title: string
  /** Where this happens in the console, shown as "Settings → …". */
  where: string
  body: string
  /** Screenshot name in src/assets/shots, and the console path it shows. */
  shot: { name: string; path: string; alt: string }
  points?: string[]
}

export const STEPS: Step[] = [
  {
    id: 'connect',
    title: 'Connect your servers',
    where: 'Fleet → Add server',
    body: 'Copy one install command onto each server. routini-runner dials out to Routini over HTTPS, so there are no inbound ports and no SSH keys to hand over. Each server shows up with live disk, memory and load, grouped and tagged the way you work.',
    shot: {
      name: 'fleet',
      path: '/o/northwind/fleet',
      alt: 'Fleet: four servers in the build, db and web groups, all online on routini-runner 0.4.1, with disk and memory meters; build-01 can run agents. The dock on the right lists the same servers.',
    },
    points: [
      'An audited browser terminal on any server, from the card or the dock',
      'Servers installed with --enable-agents also run agent steps and environments',
      'New runner versions install from the console',
    ],
  },
  {
    id: 'job',
    title: 'Describe the job',
    where: 'Jobs → New job',
    body: 'A job is a trigger and its steps. Here a coding agent bumps the storefront’s dependencies every weekday at 3 a.m. Pacific, runs npm test, and opens a pull request. It runs on whichever build server is least busy, and the editor checks that one can take it.',
    shot: {
      name: 'job',
      path: '/o/northwind/jobs',
      alt: 'The job editor: a schedule trigger, and an agent step with its prompt, Claude Code as the agent, "Run on: a host from a pool" with group build and tag ci, and "1 runner hosts match; 1 can run agents now"',
    },
    points: [
      'Triggers: by hand, on a schedule, from a webhook, or when an alert fires',
      'Steps: HTTP checks, commands on servers, Azure Boards queries, Teams messages, Factory builds, coding agents and approvals',
      'Agents: Claude Code or Omnimancer, on your own model key',
    ],
  },
  {
    id: 'guardrails',
    title: 'Set the guardrails',
    where: 'Settings → Policy',
    body: 'Your org policy decides what needs a person. Out of the box, any command on a server tagged prod waits for an admin. Agents reach the internet only through the credential broker, which allows the hosts on your list and adds real keys outside their sandbox.',
    shot: {
      name: 'policy',
      path: '/o/northwind/settings/policy',
      alt: 'Settings, Policy: the rule "Commands on production hosts need approval", and the egress allow-list of hosts agents may reach',
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
    id: 'incident',
    title: 'Turn alerts into postmortems',
    where: 'Incidents',
    body: 'Point Alertmanager, Grafana or any webhook at Routini. A firing alert opens an incident and runs the matching runbook on the server it names. When the alert clears, the incident closes and Routini drafts the postmortem from what actually happened, ready for you to finish.',
    shot: {
      name: 'incident',
      path: '/o/northwind/incidents/1',
      alt: 'A resolved incident, DiskAlmostFull on web-02: the alert’s labels, a timeline from alert to runbook to resolution, and a generated postmortem draft',
    },
  },
  {
    id: 'tools',
    title: 'Connect your tools',
    where: 'Integrations',
    body: 'Connect GitHub, GitLab, Azure DevOps, Jira, Linear, Slack, Teams, Sentry, PagerDuty, Datadog, Cloudflare, DigitalOcean or Factory, and choose which agents may use each one. Agents only ever hold a placeholder; the broker adds the real key on the way out.',
    shot: {
      name: 'integrations',
      path: '/o/northwind/integrations',
      alt: 'Integrations: cards for GitHub, Slack, Jira, Notion, Linear, monday.com, HubSpot, Azure DevOps, Microsoft Teams, GitLab, DigitalOcean, Sentry, PagerDuty, Datadog, Cloudflare and Factory, with ttyy.ai coming soon',
    },
  },
]

/** The steps the front page previews; /how-it-works has all of them. */
export const PREVIEW = ['connect', 'job', 'run', 'incident']

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
